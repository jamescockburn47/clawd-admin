"""Wake word listener for Clawd.

Runs on Pi 5 with USB microphone. Uses energy-based voice activity detection
combined with Whisper transcription on EVO X2 for wake phrase detection.

When speech is detected (RMS exceeds threshold), records until silence, sends
to EVO X2 Whisper, and checks if the transcription starts with "hey clawd"
(or similar). If matched, strips the wake phrase and routes the command.

Handles USB mics that only support 44100/48000 Hz by recording at native
rate and resampling to 16kHz for Whisper.

Usage:
    python3 wake_listener.py
    python3 wake_listener.py --test-mic
    python3 wake_listener.py --list-devices

Requires: pyaudio, requests, scipy, numpy
"""

import io
import os
import re
import sys
import wave
import time
import struct
import logging
import argparse
import tempfile
from math import gcd

import pyaudio
import numpy as np
import requests
from scipy.signal import resample_poly

# --- Config ---

TARGET_RATE = 16000  # Whisper expects 16kHz
CHANNELS = 1
FORMAT = pyaudio.paInt16
CHUNK_MS = 80  # 80ms chunks
SPEECH_CHUNKS = 1280  # 1280 samples at 16kHz = 80ms

# Wake phrase detection — match "clawd"/"claude" anywhere in first few words.
# Whisper often drops or repositions "hey clawd" so anchoring to ^ is too strict.
# Instead: check if "clawd", "claude", "cloud" (as wake word) appears anywhere
# in the first ~30 chars of the transcription.
def has_wake_phrase(text):
    """Check if transcription contains the wake phrase, return True/False."""
    # Check first 40 chars for any variant of "clawd"/"claude"
    head = text[:40].lower()
    wake_words = ["clawd", "claude", "cloud", "claud", "clawed", "klawd", "klaud", "claw"]
    return any(w in head for w in wake_words)

def strip_wake_phrase(text):
    """Remove wake phrase and surrounding words from start of transcription."""
    # Remove common prefixes: "hey clawd", "I'm Claude", "Claude,", etc.
    cleaned = re.sub(
        r"^(hey|hay|eh|a|i'?m|i am)?\s*,?\s*(clawd|claude?|cloud|clawed|klawd|klaud|claw)\b[.,!?\s]*",
        "", text, flags=re.IGNORECASE
    ).strip()
    return cleaned if cleaned else text  # fallback to original if regex ate everything

# Voice activity detection
MIC_GAIN = float(os.environ.get("MIC_GAIN", "10.0"))
SPEECH_THRESHOLD = int(os.environ.get("SPEECH_THRESHOLD", "2000"))  # RMS after gain to trigger recording
SPEECH_CONFIRM_CHUNKS = int(os.environ.get("SPEECH_CONFIRM_CHUNKS", "3"))  # consecutive chunks above threshold
SILENCE_THRESHOLD = int(os.environ.get("SILENCE_THRESHOLD", "1500"))  # RMS after gain for silence detection
SILENCE_DURATION = float(os.environ.get("SILENCE_DURATION", "1.2"))  # seconds of silence to stop
MAX_RECORD_SECONDS = float(os.environ.get("MAX_RECORD_SECONDS", "15"))
MIN_RECORD_SECONDS = float(os.environ.get("MIN_RECORD_SECONDS", "0.5"))
COOLDOWN = float(os.environ.get("COOLDOWN", "2.0"))  # seconds between detections

# Endpoints
EVO_TRANSCRIBE_URL = os.environ.get("EVO_TRANSCRIBE_URL", "http://192.168.1.230:5100/transcribe")
EVO_ROUTE_URL = os.environ.get("EVO_ROUTE_URL", "http://192.168.1.230:5100/transcribe-and-route")
CLAWDBOT_URL = os.environ.get("CLAWDBOT_URL", "http://localhost:3000")
DASHBOARD_TOKEN = os.environ.get("DASHBOARD_TOKEN", "VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM")

# Audio device
DEVICE_INDEX = os.environ.get("AUDIO_DEVICE_INDEX")

# Logging
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("wake-listener")

# Suppress ALSA/JACK noise
os.environ.setdefault("PYTHONWARNINGS", "ignore")


def find_usb_mic(pa):
    """Find the USB microphone device index and native sample rate."""
    for i in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(i)
        name = info.get("name", "").lower()
        if "usb" in name and info.get("maxInputChannels", 0) > 0:
            native_rate = int(info["defaultSampleRate"])
            logger.info(f"Found USB mic: index={i}, name={info['name']}, rate={native_rate}")
            return i, native_rate
    return None, None


class Resampler:
    """Resample audio from device rate to 16kHz using polyphase filter."""

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
        """Resample int16 numpy array with optional gain, return int16 numpy array."""
        float_audio = audio_int16.astype(np.float64)
        if gain != 1.0:
            float_audio *= gain
        if self.up == 1 and self.down == 1:
            return np.clip(float_audio, -32768, 32767).astype(np.int16)
        resampled = resample_poly(float_audio, self.up, self.down)
        return np.clip(resampled, -32768, 32767).astype(np.int16)

    def device_chunk_size(self):
        """How many samples to read from device to get ~80ms after resampling."""
        if self.up == 1 and self.down == 1:
            return SPEECH_CHUNKS
        return int(SPEECH_CHUNKS * self.src_rate / self.dst_rate)


def rms_np(audio_int16):
    """Calculate RMS of int16 numpy array."""
    if len(audio_int16) == 0:
        return 0.0
    return float(np.sqrt(np.mean(audio_int16.astype(np.float64) ** 2)))


def frames_to_wav(frames_16k, sample_rate=TARGET_RATE):
    """Convert list of int16 numpy arrays to WAV bytes at 16kHz."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        for f in frames_16k:
            wf.writeframes(f.tobytes())
    return buf.getvalue()


# strip_wake_phrase is now defined above with has_wake_phrase


def transcribe(wav_bytes):
    """Send WAV to EVO X2 for Whisper transcription.

    Returns transcription text or None.
    """
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(wav_bytes)
            tmp_path = tmp.name

        with open(tmp_path, "rb") as f:
            resp = requests.post(
                EVO_TRANSCRIBE_URL,
                files={"file": ("audio.wav", f, "audio/wav")},
                data={"language": "en"},
                timeout=30,
            )

        os.unlink(tmp_path)

        if resp.status_code != 200:
            logger.error(f"EVO transcribe returned {resp.status_code}: {resp.text}")
            return None

        result = resp.json()
        # EVO returns {"transcription": {"text": ..., "duration": ...}}
        transcription = result.get("transcription", result)
        text = transcription.get("text", "").strip()
        duration = transcription.get("duration", 0)
        logger.info(f"Whisper ({duration:.1f}s audio): {text!r}")
        return text if text else None

    except requests.exceptions.ConnectionError:
        logger.error("Cannot reach EVO X2 transcription service")
        return None
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        return None


def route_command(text):
    """Send text to EVO X2 for command routing.

    Returns route dict or None.
    """
    try:
        resp = requests.post(
            EVO_ROUTE_URL.replace("/transcribe-and-route", "/route-command"),
            json={"text": text},
            timeout=10,
        )
        if resp.status_code == 200:
            return resp.json()
        else:
            logger.error(f"EVO route returned {resp.status_code}: {resp.text}")
            return None
    except Exception as e:
        logger.error(f"Route error: {e}")
        return None


def send_to_clawdbot(text, route=None):
    """Send command to Clawdbot. Uses voice-local for routed commands, voice-command for Claude."""
    try:
        if route and route.get("action") and route["action"] != "claude":
            # Tier 1/2: fast local execution
            action = route["action"]
            params = route.get("params", {})
            resp = requests.post(
                f"{CLAWDBOT_URL}/api/voice-local",
                json={"action": action, "params": params, "text": text, "tier": route.get("tier", 0)},
                headers={"Authorization": f"Bearer {DASHBOARD_TOKEN}"},
                timeout=10,
            )
            if resp.status_code == 200:
                logger.info(f"Local command: {action} (tier {route.get('tier', '?')}, {route.get('latency_ms', '?')}ms)")
                return True
            else:
                logger.error(f"voice-local returned {resp.status_code}: {resp.text}")

        # Tier 3: complex command — route through Claude
        resp = requests.post(
            f"{CLAWDBOT_URL}/api/voice-command",
            json={"text": text, "source": "wake_word"},
            headers={"Authorization": f"Bearer {DASHBOARD_TOKEN}"},
            timeout=30,
        )
        if resp.status_code == 200:
            logger.info(f"Command sent to Claude: {text!r}")
            return True
        else:
            logger.error(f"Clawdbot returned {resp.status_code}: {resp.text}")
            return False
    except Exception as e:
        logger.error(f"Clawdbot error: {e}")
        return False


def notify_dashboard(event, data=None):
    """Send a voice status event to the dashboard via SSE trigger."""
    try:
        requests.post(
            f"{CLAWDBOT_URL}/api/voice-status",
            json={"event": event, **(data or {})},
            headers={"Authorization": f"Bearer {DASHBOARD_TOKEN}"},
            timeout=5,
        )
    except Exception as e:
        logger.debug(f"Dashboard notify failed ({event}): {e}")


def main():
    parser = argparse.ArgumentParser(description="Clawd wake word listener")
    parser.add_argument("--test-mic", action="store_true", help="Test microphone levels for 5 seconds")
    parser.add_argument("--list-devices", action="store_true", help="List audio devices and exit")
    parser.add_argument("--debug-vad", action="store_true", help="Show live RMS levels and speech detection")
    args = parser.parse_args()

    pa = pyaudio.PyAudio()

    if args.list_devices:
        for i in range(pa.get_device_count()):
            info = pa.get_device_info_by_index(i)
            if info.get("maxInputChannels", 0) > 0:
                print(f"  [{i}] {info['name']} (channels={info['maxInputChannels']}, rate={info['defaultSampleRate']})")
        pa.terminate()
        return

    # Find mic
    if DEVICE_INDEX:
        dev_idx = int(DEVICE_INDEX)
        info = pa.get_device_info_by_index(dev_idx)
        native_rate = int(info["defaultSampleRate"])
    else:
        dev_idx, native_rate = find_usb_mic(pa)

    if dev_idx is None:
        logger.error("No USB microphone found. Use --list-devices to check.")
        pa.terminate()
        sys.exit(1)

    resampler = Resampler(native_rate)
    device_chunk = resampler.device_chunk_size()

    if args.test_mic:
        logger.info(f"Testing mic (device {dev_idx}, {native_rate}Hz, gain={MIC_GAIN}x) for 5 seconds...")
        stream = pa.open(
            format=FORMAT, channels=CHANNELS, rate=native_rate,
            input=True, input_device_index=dev_idx, frames_per_buffer=device_chunk,
        )
        chunks_per_sec = native_rate // device_chunk
        for _ in range(5 * chunks_per_sec):
            data = stream.read(device_chunk, exception_on_overflow=False)
            audio = np.frombuffer(data, dtype=np.int16)
            boosted = resampler.resample(audio, gain=MIC_GAIN)
            level = rms_np(boosted)
            bars = int(level / 200)
            marker = " <<< SPEECH" if level > SPEECH_THRESHOLD else ""
            print(f"\r  Level: {'|' * min(bars, 50):50s} {level:5.0f}{marker}", end="", flush=True)
        print()
        stream.stop_stream()
        stream.close()
        pa.terminate()
        logger.info(f"Speech threshold: {SPEECH_THRESHOLD}. Adjust SPEECH_THRESHOLD env if needed.")
        return

    # Open mic stream at native rate
    stream = pa.open(
        format=FORMAT,
        channels=CHANNELS,
        rate=native_rate,
        input=True,
        input_device_index=dev_idx,
        frames_per_buffer=device_chunk,
    )

    logger.info(f"Listening on device {dev_idx} ({native_rate}Hz, gain={MIC_GAIN}x)")
    logger.info(f"Speech threshold: {SPEECH_THRESHOLD}, silence: {SILENCE_THRESHOLD}, wake phrase: 'hey clawd'")
    notify_dashboard("listening")

    last_detection = 0
    speech_count = 0  # consecutive chunks above speech threshold

    try:
        while True:
            # --- Phase 1: Wait for speech ---
            data = stream.read(device_chunk, exception_on_overflow=False)
            audio_native = np.frombuffer(data, dtype=np.int16)
            audio_16k = resampler.resample(audio_native, gain=MIC_GAIN)
            level = rms_np(audio_16k)

            if args.debug_vad:
                bars = int(level / 200)
                marker = " <<< SPEECH" if level > SPEECH_THRESHOLD else ""
                print(f"\r  [{level:5.0f}] {'|' * min(bars, 50):50s}{marker}", end="", flush=True)

            if level > SPEECH_THRESHOLD:
                speech_count += 1
            else:
                speech_count = 0
                continue

            if speech_count < SPEECH_CONFIRM_CHUNKS:
                continue

            # Cooldown check
            now = time.time()
            if now - last_detection < COOLDOWN:
                speech_count = 0
                continue

            # --- Phase 2: Speech detected — record until silence ---
            logger.info(f"Speech detected (RMS={level:.0f}), recording...")
            # Include the chunks that triggered detection
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
                        logger.info(f"Silence after {elapsed:.1f}s recording")
                        break
                else:
                    silence_start = None

                if elapsed > MAX_RECORD_SECONDS:
                    logger.info(f"Max recording time ({MAX_RECORD_SECONDS}s)")
                    break

            if elapsed < MIN_RECORD_SECONDS:
                logger.info("Recording too short, ignoring")
                speech_count = 0
                continue

            # --- Phase 3: Transcribe and check for wake phrase ---
            notify_dashboard("processing")
            wav_bytes = frames_to_wav(frames_16k)
            logger.info(f"Recorded {elapsed:.1f}s, transcribing on EVO...")

            text = transcribe(wav_bytes)
            if not text:
                logger.info("No speech transcribed, resuming")
                speech_count = 0
                notify_dashboard("listening")
                continue

            # Check for wake phrase
            if has_wake_phrase(text):
                last_detection = time.time()
                command = strip_wake_phrase(text)
                logger.info(f"Wake phrase matched! Command: {command!r}")
                notify_dashboard("activated")  # ack tone only on confirmed wake phrase

                if not command:
                    # User just said "hey clawd" with nothing after
                    logger.info("Wake phrase only, no command — waiting for next utterance")
                    notify_dashboard("listening")
                    speech_count = 0
                    continue

                # Route the command
                notify_dashboard("command", {"text": command})
                route = route_command(command)
                if route:
                    tier = route.get("tier", "?")
                    action = route.get("action", "claude")
                    logger.info(f"Route: {action} (tier {tier}, {route.get('latency_ms', '?')}ms)")
                else:
                    logger.info("Route failed, sending to Claude")

                send_to_clawdbot(command, route)
                notify_dashboard("result", {"text": command})
            else:
                # Not for us — discard
                logger.info(f"No wake phrase in: {text!r}")

            speech_count = 0
            notify_dashboard("listening")

    except KeyboardInterrupt:
        logger.info("Shutting down...")
    finally:
        stream.stop_stream()
        stream.close()
        pa.terminate()
        notify_dashboard("stopped")


if __name__ == "__main__":
    main()
