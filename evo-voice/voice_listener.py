"""Voice listener for Clawd — runs on EVO X2.

Records from USB mic, transcribes locally with Whisper (no network hop for audio),
checks for "hey clawd" wake phrase, routes command, sends to Pi's Clawdbot.

The EVO X2 has Whisper loaded in memory, so transcription is ~2s with zero
network latency for audio transfer.

Usage:
    python3 voice_listener.py
    python3 voice_listener.py --test-mic
    python3 voice_listener.py --list-devices
"""

import io
import os
import re
import sys
import wave
import time
import logging
import argparse
import tempfile
from math import gcd

import pyaudio
import numpy as np
import requests
from scipy.signal import resample_poly

# --- Config ---

TARGET_RATE = 16000
CHANNELS = 1
FORMAT = pyaudio.paInt16
CHUNK_SAMPLES = 1280  # 80ms at 16kHz

# Gain — EVO mic signal; increase if speech is quiet (test with --test-mic)
MIC_GAIN = float(os.environ.get("MIC_GAIN", "6.0"))

# VAD thresholds (after gain) — lower SPEECH_THRESHOLD if missing quiet speech
SPEECH_THRESHOLD = int(os.environ.get("SPEECH_THRESHOLD", "1500"))
SPEECH_CONFIRM_CHUNKS = int(os.environ.get("SPEECH_CONFIRM_CHUNKS", "3"))
SILENCE_THRESHOLD = int(os.environ.get("SILENCE_THRESHOLD", "1200"))
SILENCE_DURATION = float(os.environ.get("SILENCE_DURATION", "2.0"))  # longer to capture full phrases
MAX_RECORD_SECONDS = float(os.environ.get("MAX_RECORD_SECONDS", "12"))
MIN_RECORD_SECONDS = float(os.environ.get("MIN_RECORD_SECONDS", "0.5"))
COOLDOWN = float(os.environ.get("COOLDOWN", "2.0"))

# Clawdbot on Pi
CLAWDBOT_URL = os.environ.get("CLAWDBOT_URL", "http://192.168.1.211:3000")
DASHBOARD_TOKEN = os.environ.get("DASHBOARD_TOKEN", "VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM")

# Local routing endpoint (same machine)
ROUTE_URL = os.environ.get("ROUTE_URL", "http://localhost:5100/route-command")

# Audio device — "usb" to auto-detect, or integer index
DEVICE_INDEX = os.environ.get("AUDIO_DEVICE_INDEX", "usb")

# Logging
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("voice-listener")
os.environ.setdefault("PYTHONWARNINGS", "ignore")


# --- Wake phrase detection ---

def has_wake_phrase(text):
    """Check if transcription contains the wake phrase."""
    head = text[:45].lower()
    wake_words = ["clawd", "claude", "claud", "clawed", "klawd", "klaud", "cloud", "claw"]
    return any(w in head for w in wake_words)


def strip_wake_phrase(text):
    """Remove wake phrase from transcription."""
    cleaned = re.sub(
        r"^(hey|hay|eh|a|ok|okay|i'?m|i am)?\s*,?\s*(clawd|claude?|cloud|clawed|klawd|klaud|claw)\b[.,!?\s]*",
        "", text, flags=re.IGNORECASE
    ).strip()
    return cleaned if cleaned else text


# --- Audio helpers ---

def find_usb_mic(pa):
    """Find USB mic device index and native sample rate."""
    for i in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(i)
        name = info.get("name", "").lower()
        if "usb" in name and info.get("maxInputChannels", 0) > 0:
            native_rate = int(info["defaultSampleRate"])
            logger.info(f"Found USB mic: index={i}, name={info['name']}, rate={native_rate}")
            return i, native_rate
    return None, None


class Resampler:
    def __init__(self, src_rate, dst_rate=TARGET_RATE):
        self.src_rate = src_rate
        self.dst_rate = dst_rate
        if src_rate == dst_rate:
            self.up = self.down = 1
        else:
            d = gcd(src_rate, dst_rate)
            self.up = dst_rate // d
            self.down = src_rate // d
        logger.info(f"Resampler: {src_rate} -> {dst_rate} Hz (up={self.up}, down={self.down})")

    def resample(self, audio_int16, gain=1.0):
        float_audio = audio_int16.astype(np.float64)
        if gain != 1.0:
            float_audio *= gain
        if self.up == 1 and self.down == 1:
            return np.clip(float_audio, -32768, 32767).astype(np.int16)
        resampled = resample_poly(float_audio, self.up, self.down)
        return np.clip(resampled, -32768, 32767).astype(np.int16)

    def device_chunk_size(self):
        if self.up == 1 and self.down == 1:
            return CHUNK_SAMPLES
        return int(CHUNK_SAMPLES * self.src_rate / self.dst_rate)


def rms_np(audio_int16):
    if len(audio_int16) == 0:
        return 0.0
    return float(np.sqrt(np.mean(audio_int16.astype(np.float64) ** 2)))


# --- Whisper (local, in-process) ---

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")  # small=612ms, medium=1460ms, large-v3=2575ms

_whisper_model = None

def get_whisper():
    global _whisper_model
    if _whisper_model is None:
        logger.info(f"Loading Whisper model '{WHISPER_MODEL}'...")
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        logger.info("Whisper model loaded")
    return _whisper_model


def transcribe_local(frames_16k):
    """Transcribe 16kHz int16 frames directly — no file I/O, no network."""
    audio = np.concatenate(frames_16k).astype(np.float32) / 32768.0
    model = get_whisper()
    # VAD disabled: was filtering out real speech; rely on our energy-based VAD instead
    segments, info = model.transcribe(
        audio, language="en", beam_size=3, best_of=1,
        vad_filter=False,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    logger.info(f"Whisper ({info.duration:.1f}s): {text!r}")
    return text if text else None


# --- TTS (Piper, local) ---

TTS_MODEL = os.environ.get("TTS_MODEL", os.path.expanduser("~/clawdbot-memory/tts-voices/en_GB-alan-medium.onnx"))
_tts_voice = None

def get_tts():
    global _tts_voice
    if _tts_voice is None:
        if not os.path.exists(TTS_MODEL):
            logger.warning(f"TTS model not found: {TTS_MODEL}")
            return None
        from piper import PiperVoice
        _tts_voice = PiperVoice.load(TTS_MODEL)
        logger.info(f"TTS voice loaded: {TTS_MODEL}")
    return _tts_voice


def speak(text):
    """Synthesize speech and play through default output."""
    voice = get_tts()
    if not voice:
        return
    try:
        import wave as wave_mod
        chunks = list(voice.synthesize(text))
        audio_bytes = b"".join(c.audio_int16_bytes for c in chunks)
        sr = chunks[0].sample_rate
        # Send WAV to Pi dashboard for playback
        buf = io.BytesIO()
        with wave_mod.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(audio_bytes)
        import base64
        wav_b64 = base64.b64encode(buf.getvalue()).decode()
        notify_dashboard("speak", {"audio": wav_b64})
        logger.info(f"TTS: '{text}' ({len(audio_bytes)//2/sr:.1f}s)")
    except Exception as e:
        logger.error(f"TTS error: {e}")


# --- Network helpers ---

def route_command(text):
    try:
        resp = requests.post(ROUTE_URL, json={"text": text}, timeout=5)
        if resp.status_code == 200:
            return resp.json()
    except Exception as e:
        logger.error(f"Route error: {e}")
    return None


def send_to_clawdbot(text, route=None):
    try:
        if route and route.get("action") and route["action"] != "claude":
            resp = requests.post(
                f"{CLAWDBOT_URL}/api/voice-local",
                json={"action": route["action"], "params": route.get("params", {}),
                       "text": text, "tier": route.get("tier", 0)},
                headers={"Authorization": f"Bearer {DASHBOARD_TOKEN}"},
                timeout=10,
            )
            if resp.status_code == 200:
                logger.info(f"Local: {route['action']} (tier {route.get('tier','?')}, {route.get('latency_ms','?')}ms)")
                return True
            else:
                logger.error(f"voice-local {resp.status_code}: {resp.text}")

        resp = requests.post(
            f"{CLAWDBOT_URL}/api/voice-command",
            json={"text": text, "source": "wake_word"},
            headers={"Authorization": f"Bearer {DASHBOARD_TOKEN}"},
            timeout=30,
        )
        if resp.status_code == 200:
            logger.info(f"Claude: {text!r}")
            return True
        else:
            logger.error(f"Clawdbot {resp.status_code}: {resp.text}")
            return False
    except Exception as e:
        logger.error(f"Clawdbot error: {e}")
        return False


def notify_dashboard(event, data=None):
    try:
        requests.post(
            f"{CLAWDBOT_URL}/api/voice-status",
            json={"event": event, **(data or {})},
            headers={"Authorization": f"Bearer {DASHBOARD_TOKEN}"},
            timeout=3,
        )
    except Exception:
        pass


# --- Main loop ---

def main():
    parser = argparse.ArgumentParser(description="Clawd voice listener (EVO X2)")
    parser.add_argument("--test-mic", action="store_true")
    parser.add_argument("--list-devices", action="store_true")
    args = parser.parse_args()

    pa = pyaudio.PyAudio()

    if args.list_devices:
        for i in range(pa.get_device_count()):
            info = pa.get_device_info_by_index(i)
            if info.get("maxInputChannels", 0) > 0:
                print(f"  [{i}] {info['name']} ch={info['maxInputChannels']} rate={info['defaultSampleRate']}")
        pa.terminate()
        return

    # Find mic
    if DEVICE_INDEX == "usb":
        dev_idx, native_rate = find_usb_mic(pa)
    else:
        dev_idx = int(DEVICE_INDEX)
        info = pa.get_device_info_by_index(dev_idx)
        native_rate = int(info["defaultSampleRate"])

    if dev_idx is None:
        logger.error("No USB microphone found")
        pa.terminate()
        sys.exit(1)

    resampler = Resampler(native_rate)
    device_chunk = resampler.device_chunk_size()

    if args.test_mic:
        logger.info(f"Testing mic (device {dev_idx}, {native_rate}Hz, gain={MIC_GAIN}x) for 5s...")
        stream = pa.open(format=FORMAT, channels=CHANNELS, rate=native_rate,
                         input=True, input_device_index=dev_idx, frames_per_buffer=device_chunk)
        chunks_per_sec = native_rate // device_chunk
        for _ in range(5 * chunks_per_sec):
            data = stream.read(device_chunk, exception_on_overflow=False)
            audio = np.frombuffer(data, dtype=np.int16)
            boosted = resampler.resample(audio, gain=MIC_GAIN)
            level = rms_np(boosted)
            bars = int(level / 200)
            marker = " <<< SPEECH" if level > SPEECH_THRESHOLD else ""
            print(f"\r  [{level:5.0f}] {'|' * min(bars, 50):50s}{marker}", end="", flush=True)
        print()
        stream.stop_stream()
        stream.close()
        pa.terminate()
        return

    # Pre-load models so first command isn't slow
    logger.info("Pre-loading Whisper + TTS...")
    get_whisper()
    get_tts()

    stream = pa.open(format=FORMAT, channels=CHANNELS, rate=native_rate,
                     input=True, input_device_index=dev_idx, frames_per_buffer=device_chunk)

    logger.info(f"Listening: device={dev_idx}, rate={native_rate}Hz, gain={MIC_GAIN}x, "
                f"speech={SPEECH_THRESHOLD}, silence={SILENCE_THRESHOLD}")
    notify_dashboard("listening")

    last_detection = 0
    speech_count = 0

    try:
        while True:
            data = stream.read(device_chunk, exception_on_overflow=False)
            audio_native = np.frombuffer(data, dtype=np.int16)
            audio_16k = resampler.resample(audio_native, gain=MIC_GAIN)
            level = rms_np(audio_16k)

            if level > SPEECH_THRESHOLD:
                speech_count += 1
            else:
                speech_count = 0
                continue

            if speech_count < SPEECH_CONFIRM_CHUNKS:
                continue

            now = time.time()
            if now - last_detection < COOLDOWN:
                speech_count = 0
                continue

            # --- Record until silence ---
            logger.info(f"Speech detected (RMS={level:.0f}), recording...")
            frames_16k = [audio_16k]
            silence_start = None
            record_start = time.time()

            while True:
                data = stream.read(device_chunk, exception_on_overflow=False)
                audio_native = np.frombuffer(data, dtype=np.int16)
                audio_16k = resampler.resample(audio_native, gain=MIC_GAIN)
                frames_16k.append(audio_16k)
                elapsed = time.time() - record_start
                level = rms_np(audio_16k)

                if level < SILENCE_THRESHOLD:
                    if silence_start is None:
                        silence_start = time.time()
                    elif time.time() - silence_start > SILENCE_DURATION and elapsed > MIN_RECORD_SECONDS:
                        logger.info(f"Silence after {elapsed:.1f}s")
                        break
                else:
                    silence_start = None  # speech resumed, keep recording

                if elapsed > MAX_RECORD_SECONDS:
                    logger.info(f"Max recording ({MAX_RECORD_SECONDS}s)")
                    break

            if elapsed < MIN_RECORD_SECONDS:
                speech_count = 0
                continue

            # --- Transcribe locally (no network!) ---
            t0 = time.time()
            text = transcribe_local(frames_16k)
            transcribe_ms = (time.time() - t0) * 1000
            logger.info(f"Transcription took {transcribe_ms:.0f}ms")

            if not text:
                logger.info("No speech transcribed")
                notify_dashboard("listening")  # Reset UI so not stuck in processing
                speech_count = 0
                continue

            # --- Wake phrase check ---
            if has_wake_phrase(text):
                last_detection = time.time()
                command = strip_wake_phrase(text)
                logger.info(f"Wake phrase matched! Command: {command!r}")
                notify_dashboard("activated")

                if not command:
                    speak("Yes?")
                    logger.info("Wake phrase only, no command")
                    notify_dashboard("listening")
                    speech_count = 0
                    continue

                notify_dashboard("command", {"text": command})
                route = route_command(command)
                if route:
                    logger.info(f"Route: {route['action']} (tier {route.get('tier','?')})")
                result = send_to_clawdbot(command, route)
                notify_dashboard("result", {"text": command})

                # TTS confirmation for local commands
                went_to_claude = not route or route.get("action") == "claude"
                if not went_to_claude:
                    action = route.get("action", "")
                    params = route.get("params", {})
                    if action == "navigate":
                        speak(f"Showing {params.get('panel', 'dashboard')}")
                    elif action == "todo_add":
                        speak("Added")
                    elif action == "todo_complete":
                        speak("Done")
                    elif action == "refresh":
                        speak("Refreshed")
                    elif action == "remember":
                        speak("Noted")

                # Delay "listening" after Claude call so dashboard can show response for ~6s
                if went_to_claude:
                    import threading
                    def delayed_listening():
                        time.sleep(6.0)
                        notify_dashboard("listening")
                    threading.Thread(target=delayed_listening, daemon=True).start()
                else:
                    notify_dashboard("listening")
            else:
                logger.info(f"No wake phrase in: {text!r}")
                notify_dashboard("listening")

            speech_count = 0

    except KeyboardInterrupt:
        logger.info("Shutting down...")
    finally:
        stream.stop_stream()
        stream.close()
        pa.terminate()
        notify_dashboard("stopped")


if __name__ == "__main__":
    main()
