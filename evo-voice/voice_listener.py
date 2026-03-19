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
import json
import os
import re
import sys
from collections import deque
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

try:
    from webrtc_noise_gain import AudioProcessor
    # Positional args: (auto_gain_dbfs, noise_suppression_level)
    _noise_processor = AudioProcessor(3, 3)
    _HAS_NOISE_SUPPRESSION = True
except (ImportError, TypeError):
    _noise_processor = None
    _HAS_NOISE_SUPPRESSION = False

# --- Config ---

TARGET_RATE = 16000
CHANNELS = 1
FORMAT = pyaudio.paInt16
CHUNK_SAMPLES = 1280  # 80ms at 16kHz

# Gain — EVO mic signal; increase if speech is quiet (test with --test-mic)
MIC_GAIN = float(os.environ.get("MIC_GAIN", "3.5"))

# VAD thresholds (after gain) — lower SPEECH_THRESHOLD if missing quiet speech
SPEECH_THRESHOLD = int(os.environ.get("SPEECH_THRESHOLD", "1800"))
SPEECH_CONFIRM_CHUNKS = int(os.environ.get("SPEECH_CONFIRM_CHUNKS", "3"))
SILENCE_THRESHOLD = int(os.environ.get("SILENCE_THRESHOLD", "700"))
SILENCE_DURATION = float(os.environ.get("SILENCE_DURATION", "1.2"))  # 1.2s — faster turnaround
MAX_RECORD_SECONDS = float(os.environ.get("MAX_RECORD_SECONDS", "12"))
MIN_RECORD_SECONDS = float(os.environ.get("MIN_RECORD_SECONDS", "0.5"))
COOLDOWN = float(os.environ.get("COOLDOWN", "1.5"))

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


# --- Contacts & vocabulary biasing ---

CONTACTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "contacts.json")
_contacts = {}
_corrections = {}  # {"mj": "MG", "melissa": "Melissa"}
_whisper_prompt = ""

def _load_contacts():
    global _contacts, _corrections, _whisper_prompt
    try:
        with open(CONTACTS_FILE) as f:
            _contacts = json.load(f)
    except FileNotFoundError:
        logger.warning(f"No contacts file: {CONTACTS_FILE}")
        return

    # Build correction map (common mishearings → correct form)
    names = set()
    for c in _contacts.get("contacts", []):
        names.add(c["name"])
        for alias in c.get("aliases", []):
            names.add(alias)

    # Whisper initial_prompt: biases decoder toward these tokens.
    # CRITICAL: include the wake phrase itself — without it Whisper transcribes
    # "hey Claude" as "Take Lord", "Accord", etc.
    owner = _contacts.get("owner", "James")
    all_names = sorted(names)
    _whisper_prompt = (
        f"Hey Claude, hey Clawd. {owner} is talking to Claude. "
        f"Names: {', '.join(all_names)}. "
        "Hey Claude, what's happening today? Hey Claude, add a todo."
    )

    # Phonetic correction map — add known mishearings here
    _corrections = {
        "mj": "MG", "m.j.": "MG", "m j": "MG",
        "emg": "MG", "m.g.": "MG",
        "mg": "MG",  # preserve correct casing
    }
    logger.info(f"Contacts loaded: {len(all_names)} names, prompt: {_whisper_prompt!r}")


def _apply_corrections(text):
    """Fix known Whisper mishearings using contacts correction map."""
    if not _corrections:
        return text
    # Word-boundary replacement, case-insensitive
    for wrong, right in _corrections.items():
        text = re.sub(r'\b' + re.escape(wrong) + r'\b', right, text, flags=re.IGNORECASE)
    return text


# --- Wake phrase detection ---

# Gratitude / no-op phrases — respond politely, don't route as commands
GRATITUDE_PHRASES = {
    "thank you", "thanks", "cheers", "ta", "nice one",
    "good job", "well done", "great", "perfect", "brilliant",
    "okay thanks", "ok thanks", "thank you very much",
}

# Whisper phantom transcriptions — reject these outright
WHISPER_HALLUCINATIONS = {
    "thank you", "thanks", "thank you for watching", "bye", "goodbye",
    "you", "the", "i", "it", "a", "so", "yeah", "yes", "no", "okay",
    "um", "uh", "hmm", "mm", "oh", "ah", "ha",
    "thank you very much", "thanks for watching",
    "i'm going to", "subscribe", "like and subscribe",
    "music", "applause", "laughter",
}


def is_hallucination(text):
    """Reject common Whisper phantom transcriptions."""
    if not text:
        return True
    cleaned = text.strip().lower().rstrip(".!?,")
    if cleaned in WHISPER_HALLUCINATIONS:
        return True
    # Single word under 4 chars is almost always noise
    if len(cleaned.split()) == 1 and len(cleaned) < 4:
        return True
    return False


def has_wake_phrase(text: str) -> bool:
    """Check if text contains the wake phrase."""
    head = text[:45].lower()
    # Tier 1: unambiguous — "claude/clawd" variants always match
    if re.search(r"\b(clawd|claude?|clawed|klawd|klaud)\b", head):
        return True
    # Tier 2: ambiguous words that only count with a prefix
    # Observed Whisper mishearings: "Take Lord", "Heck Load", "A Cloud", "Hey Cloud"
    if re.search(r"\b(hey|hay|take|heck|a|eh|ok)\s+\w*\s*(lord|cloud|load|clod|cord)\b", head):
        return True
    # Tier 3: "Accord" (single-word mishearing of "hey Claude")
    if re.search(r"^accord\b", head):
        return True
    return False


def strip_wake_phrase(text):
    """Remove wake phrase from transcription. Returns '' if text is just the wake phrase."""
    cleaned = re.sub(
        r"^(hey|hay|eh|a|ok|okay|i'?m|i am|take|heck|uh)?\s*,?\s*(clawd|claude?|clawed|klawd|klaud|cloud|claw|lord|cord|accord|load|clod)\b[.,!?\s]*",
        "", text, flags=re.IGNORECASE
    ).strip()
    return cleaned


# --- Audio helpers ---

def denoise_audio(audio_16k):
    """Apply WebRTC noise suppression to 16kHz int16 audio.
    Processes in 10ms chunks (160 samples). Returns cleaned audio."""
    if not _HAS_NOISE_SUPPRESSION or _noise_processor is None:
        return audio_16k
    chunk_size = 160  # 10ms at 16kHz
    out_chunks = []
    for i in range(0, len(audio_16k), chunk_size):
        chunk = audio_16k[i:i + chunk_size]
        if len(chunk) < chunk_size:
            # Pad last chunk
            chunk = np.pad(chunk, (0, chunk_size - len(chunk)))
        result = _noise_processor.Process10ms(chunk.tobytes())
        out_chunks.append(np.frombuffer(result.audio, dtype=np.int16))
    return np.concatenate(out_chunks)[:len(audio_16k)]


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

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "distil-small.en")  # distil-small.en: fast + English-optimised

_whisper_model = None

def get_whisper():
    global _whisper_model
    if _whisper_model is None:
        logger.info(f"Loading Whisper model '{WHISPER_MODEL}'...")
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        logger.info("Whisper model loaded")
    return _whisper_model


def trim_silence(frames_16k, threshold=500):
    """Trim leading/trailing silence from recorded frames to speed up Whisper."""
    all_audio = np.concatenate(frames_16k)
    chunk_size = CHUNK_SAMPLES
    n_chunks = len(all_audio) // chunk_size
    if n_chunks < 2:
        return frames_16k

    # Find first and last chunks above threshold
    first_speech = 0
    last_speech = n_chunks - 1
    for i in range(n_chunks):
        chunk = all_audio[i * chunk_size:(i + 1) * chunk_size]
        if rms_np(chunk) > threshold:
            first_speech = i
            break
    for i in range(n_chunks - 1, -1, -1):
        chunk = all_audio[i * chunk_size:(i + 1) * chunk_size]
        if rms_np(chunk) > threshold:
            last_speech = i
            break

    # Keep 1 chunk of padding each side
    start = max(0, first_speech - 1) * chunk_size
    end = min(n_chunks, last_speech + 2) * chunk_size
    trimmed = all_audio[start:end]
    if len(trimmed) < chunk_size:
        return frames_16k
    return [trimmed]


def transcribe_local(frames_16k):
    """Transcribe 16kHz int16 frames directly — no file I/O, no network."""
    # Trim silence to reduce Whisper input length
    trimmed = trim_silence(frames_16k)
    audio = np.concatenate(trimmed).astype(np.float32) / 32768.0
    model = get_whisper()
    # VAD with very low onset to help Whisper skip noise segments.
    # language="en" skips language detection (was detecting "nn" on noise).
    # initial_prompt biases decoder toward known vocabulary (names, etc.)
    segments, info = model.transcribe(
        audio,
        beam_size=5,
        language="en",
        vad_filter=True,
        vad_parameters=dict(onset=0.1, min_speech_duration_ms=150),
        initial_prompt=_whisper_prompt or None,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    # Apply corrections for known mishearings (e.g. MJ → MG)
    text = _apply_corrections(text)
    logger.info(f"Whisper ({info.duration:.1f}s, trimmed {len(audio)/16000:.1f}s): {text!r}")
    return text if text else None


# --- TTS (Orpheus-3B via llama-server SNAC, with Piper fallback) ---

ORPHEUS_URL = os.environ.get("ORPHEUS_URL", "http://localhost:8082")
ORPHEUS_VOICE = os.environ.get("ORPHEUS_VOICE", "tara")
TTS_MODEL = os.environ.get("TTS_MODEL", os.path.expanduser("~/clawdbot-memory/tts-voices/en_GB-alan-medium.onnx"))

_snac_model = None
_piper_voice = None

def get_snac():
    """Load SNAC 24kHz audio codec for Orpheus token decoding."""
    global _snac_model
    if _snac_model is None:
        try:
            import torch
            from snac import SNAC
            _snac_model = SNAC.from_pretrained("hubertsiuzdak/snac_24khz")
            _snac_model = _snac_model.to("cpu")
            _snac_model.eval()
            logger.info("SNAC model loaded (24kHz)")
        except Exception as e:
            logger.warning(f"SNAC load failed (Orpheus TTS unavailable): {e}")
            return None
    return _snac_model


def get_piper():
    """Fallback Piper TTS."""
    global _piper_voice
    if _piper_voice is None:
        if not os.path.exists(TTS_MODEL):
            return None
        from piper import PiperVoice
        _piper_voice = PiperVoice.load(TTS_MODEL)
        logger.info(f"Piper fallback loaded: {TTS_MODEL}")
    return _piper_voice


def _orpheus_generate(text):
    """Generate SNAC audio tokens from Orpheus-3B via llama-server."""
    prompt = f"<|audio|>{ORPHEUS_VOICE}: {text}<|eot_id|>"
    try:
        resp = requests.post(
            f"{ORPHEUS_URL}/v1/completions",
            json={
                "prompt": prompt,
                "max_tokens": 8192,
                "temperature": 0.6,
                "top_p": 0.9,
                "repeat_penalty": 1.1,
            },
            timeout=30,
        )
        if resp.status_code != 200:
            logger.error(f"Orpheus HTTP {resp.status_code}")
            return None
        data = resp.json()
        return data.get("choices", [{}])[0].get("text", "")
    except Exception as e:
        logger.error(f"Orpheus request failed: {e}")
        return None


def _decode_snac_tokens(token_text):
    """Parse Orpheus custom tokens and decode SNAC to 24kHz audio."""
    import torch

    snac = get_snac()
    if snac is None:
        return None

    # Extract token IDs from <custom_token_N> pattern
    all_ids = [int(m) for m in re.findall(r'<custom_token_(\d+)>', token_text)]
    # Filter control tokens (IDs < 10) before position-based decoding
    token_ids = [tid for tid in all_ids if tid >= 10]
    if len(token_ids) < 7:
        logger.warning(f"Too few audio tokens: {len(token_ids)} (of {len(all_ids)} total)")
        return None

    # Convert token IDs to SNAC codes (position-sensitive offset)
    codes = []
    for i, tid in enumerate(token_ids):
        pos = i % 7
        code = tid - 10 - (pos * 4096)
        if 0 <= code < 4096:
            codes.append(code)
        else:
            codes.append(0)  # placeholder for out-of-range

    # Trim to multiple of 7
    n_frames = len(codes) // 7
    if n_frames == 0:
        return None
    codes = codes[:n_frames * 7]

    # Redistribute into 3 SNAC layers
    layer_0, layer_1, layer_2 = [], [], []
    for i in range(n_frames):
        base = i * 7
        layer_0.append(codes[base])
        layer_1.append(codes[base + 1])
        layer_2.append(codes[base + 2])
        layer_2.append(codes[base + 3])
        layer_1.append(codes[base + 4])
        layer_2.append(codes[base + 5])
        layer_2.append(codes[base + 6])

    layers = [
        torch.tensor(layer_0, dtype=torch.long).unsqueeze(0),
        torch.tensor(layer_1, dtype=torch.long).unsqueeze(0),
        torch.tensor(layer_2, dtype=torch.long).unsqueeze(0),
    ]

    with torch.no_grad():
        audio = snac.decode(layers)

    audio_np = audio.squeeze().cpu().numpy()
    audio_np = np.clip(audio_np, -1.0, 1.0)
    return audio_np  # 24kHz float32


def _send_audio_to_dashboard(audio_bytes, sr, label, text):
    """Send WAV audio to Pi dashboard for playback."""
    import wave as wave_mod
    import base64
    buf = io.BytesIO()
    with wave_mod.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(audio_bytes)
    wav_b64 = base64.b64encode(buf.getvalue()).decode()
    notify_dashboard("speak", {"audio": wav_b64})
    duration = len(audio_bytes) / 2 / sr
    logger.info(f"TTS ({label}): '{text[:50]}' ({duration:.1f}s)")


def speak_fast(text):
    """Quick TTS via Piper — for short acks. Returns audio duration in seconds."""
    voice = get_piper()
    if not voice:
        return 0.0
    try:
        chunks = list(voice.synthesize(text))
        audio_bytes = b"".join(c.audio_int16_bytes for c in chunks)
        sr = chunks[0].sample_rate
        _send_audio_to_dashboard(audio_bytes, sr, "Piper", text)
        return len(audio_bytes) / 2 / sr  # int16 = 2 bytes per sample
    except Exception as e:
        logger.error(f"Piper TTS error: {e}")
        return 0.0


def speak(text):
    """Full TTS for substantive responses. Returns audio duration.
    Orpheus disabled — 8-12s generation time is unusable.
    Using Piper for all TTS until streaming or faster model available."""
    return speak_fast(text)


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
                try:
                    return resp.json()
                except Exception:
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
            try:
                return resp.json()
            except Exception:
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

import threading
import queue

# Command queue — processed by a background thread so mic loop stays responsive
_command_queue = queue.Queue()

# Follow-up mode: after a Claude response, main loop allows speech without wake word
_followup_mode = threading.Event()
_followup_deadline = 0.0  # timestamp when follow-up window expires


def _command_worker():
    """Background thread: processes voice commands without blocking the mic loop."""
    global _followup_deadline
    while True:
        try:
            command, route_result = _command_queue.get(timeout=1)
        except queue.Empty:
            continue

        try:
            # Clear follow-up mode while processing a new command
            _followup_mode.clear()

            notify_dashboard("command", {"text": command})
            result = send_to_clawdbot(command, route_result)
            notify_dashboard("result", {"text": command})

            # TTS confirmation for local commands — use fast Piper for short acks
            went_to_claude = not route_result or route_result.get("action") == "claude"
            tts_dur = 0.0
            if not went_to_claude:
                action = route_result.get("action", "")
                params = route_result.get("params", {})
                if action == "navigate":
                    tts_dur = speak_fast(f"Showing {params.get('panel', 'dashboard')}")
                elif action == "todo_add":
                    tts_dur = speak_fast("Added")
                elif action == "todo_complete":
                    tts_dur = speak_fast("Done")
                elif action == "refresh":
                    tts_dur = speak_fast("Refreshed")
                elif action == "remember":
                    tts_dur = speak_fast("Noted")
                elif action == "status":
                    # Speak the status message from Pi response
                    msg = result.get("message", "") if isinstance(result, dict) else ""
                    if msg:
                        tts_dur = speak(msg) or 0.0

            # Speak Claude's response via TTS (truncate for natural speech)
            if went_to_claude and isinstance(result, dict):
                response_text = result.get("response") or result.get("message") or ""
                if response_text:
                    # Truncate to first 2 sentences or 300 chars for TTS
                    sentences = re.split(r'(?<=[.!?])\s+', response_text)
                    tts_text = " ".join(sentences[:3])
                    if len(tts_text) > 300:
                        tts_text = tts_text[:297] + "..."
                    # Strip markdown formatting for cleaner speech
                    tts_text = re.sub(r'\*\*?([^*]+)\*\*?', r'\1', tts_text)
                    tts_text = re.sub(r'[*_`#\[\]]', '', tts_text)
                    tts_dur = speak(tts_text) or 0.0

            # After Claude response, enter follow-up mode (10s window for reply)
            # No beep — the TTS response IS the acknowledgment
            if went_to_claude:
                # Wait for TTS to finish playing before opening mic for follow-up
                flush_wait = max(tts_dur + 0.5, 1.5)
                logger.debug(f"Post-TTS flush: {flush_wait:.1f}s (audio={tts_dur:.1f}s)")
                time.sleep(flush_wait)
                _followup_deadline = time.time() + 10.0
                _followup_mode.set()
                logger.info("Follow-up mode: listening for reply (10s)")
            else:
                notify_dashboard("listening")
        except Exception as e:
            logger.error(f"Command worker error: {e}")
            notify_dashboard("listening")
        finally:
            _command_queue.task_done()


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

    # Load contacts for vocabulary biasing and corrections
    _load_contacts()

    # Pre-load models so first command isn't slow
    logger.info("Pre-loading Whisper + TTS...")
    get_whisper()
    get_snac()  # Orpheus SNAC decoder
    get_piper()  # Always load Piper — needed for speak_fast() acks

    # Voice listener heartbeat — lets Pi know we're alive
    _voice_start_time = time.time()
    def _heartbeat():
        while True:
            try:
                uptime = int(time.time() - _voice_start_time)
                notify_dashboard("heartbeat", {
                    "uptime": uptime,
                    "noise_suppression": _HAS_NOISE_SUPPRESSION,
                    "whisper_model": WHISPER_MODEL,
                })
            except Exception:
                pass
            time.sleep(60)

    hb = threading.Thread(target=_heartbeat, daemon=True)
    hb.start()
    logger.info("Heartbeat started (60s interval)")

    # Start background command worker
    worker = threading.Thread(target=_command_worker, daemon=True)
    worker.start()

    stream = pa.open(format=FORMAT, channels=CHANNELS, rate=native_rate,
                     input=True, input_device_index=dev_idx, frames_per_buffer=device_chunk)

    logger.info(f"Listening: device={dev_idx}, rate={native_rate}Hz, gain={MIC_GAIN}x, "
                f"speech={SPEECH_THRESHOLD}, silence={SILENCE_THRESHOLD}, "
                f"noise_suppression={'on' if _HAS_NOISE_SUPPRESSION else 'off'}")
    notify_dashboard("listening")

    last_detection = 0
    speech_count = 0
    # Rolling pre-buffer: keeps last ~800ms of audio so we capture the wake word
    # that triggers speech detection (otherwise it's lost in the confirmation delay)
    PRE_BUFFER_CHUNKS = 10  # ~800ms at 80ms/chunk
    pre_buffer = deque(maxlen=PRE_BUFFER_CHUNKS)

    try:
        while True:
            data = stream.read(device_chunk, exception_on_overflow=False)
            audio_native = np.frombuffer(data, dtype=np.int16)
            audio_16k = resampler.resample(audio_native, gain=MIC_GAIN)
            # Apply noise suppression (strips fan noise, improves Whisper accuracy)
            audio_16k = denoise_audio(audio_16k)
            level = rms_np(audio_16k)

            # Always add to pre-buffer (even silence) so wake word is captured
            pre_buffer.append(audio_16k)

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

            # --- Speech detected! ---
            logger.info(f"Speech detected (RMS={level:.0f}), recording...")
            # No dashboard notification here — wait for wake phrase confirmation
            # to avoid ack beep on every speech detection

            # --- Record until silence (prepend pre-buffer to capture wake word) ---
            frames_16k = list(pre_buffer)
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
                notify_dashboard("listening")
                continue

            # --- Transcribe locally (no network!) ---
            t0 = time.time()
            text = transcribe_local(frames_16k)
            transcribe_ms = (time.time() - t0) * 1000
            logger.info(f"Transcription took {transcribe_ms:.0f}ms")

            if not text or is_hallucination(text):
                if text:
                    logger.info(f"Rejected hallucination: {text!r}")
                else:
                    logger.info("No speech transcribed")
                notify_dashboard("listening")
                speech_count = 0
                continue

            # --- Follow-up mode: no wake phrase needed ---
            in_followup = _followup_mode.is_set() and time.time() < _followup_deadline
            if in_followup:
                _followup_mode.clear()
                command = text.strip()
                logger.info(f"Follow-up reply: {command!r}")
                if command:
                    notify_dashboard("command", {"text": command, "message": "Working on it..."})
                    route = route_command(command)
                    if route:
                        logger.info(f"Route: {route['action']} (tier {route.get('tier','?')})")
                    _command_queue.put((command, route))
                speech_count = 0
                continue

            # Expire follow-up mode if deadline passed
            if _followup_mode.is_set() and time.time() >= _followup_deadline:
                _followup_mode.clear()
                notify_dashboard("listening")
                logger.info("Follow-up window expired")

            # --- Wake phrase check ---
            if has_wake_phrase(text):
                last_detection = time.time()
                command = strip_wake_phrase(text)
                logger.info(f"Wake phrase matched! Command: {command!r}")

                # Check if it's just gratitude (e.g. "Thank you, Claude")
                command_lower = command.lower().rstrip(".,!? ")
                if command_lower in GRATITUDE_PHRASES:
                    speak_fast("You're welcome")
                    logger.info(f"Gratitude: {command!r}")
                    notify_dashboard("listening")
                    speech_count = 0
                    continue

                if not command:
                    # Wake word only — speak ack (fast Piper) then listen for follow-up
                    ack_dur = speak_fast("Yes?")
                    logger.info("Wake phrase only — listening for follow-up")

                    # Flush mic buffer: wait for audio to finish playing on Pi + margin,
                    # then drain stale frames so Whisper doesn't transcribe our own TTS
                    flush_secs = max(ack_dur + 0.5, 1.5)
                    logger.debug(f"Flushing mic for {flush_secs:.1f}s (ack={ack_dur:.1f}s)")
                    time.sleep(flush_secs)
                    try:
                        while stream.get_read_available() > device_chunk:
                            stream.read(device_chunk, exception_on_overflow=False)
                    except Exception:
                        pass

                    followup_frames = []  # fresh start, no pre-buffer (it's stale)
                    followup_start = time.time()
                    followup_silence = None
                    got_speech = False
                    while time.time() - followup_start < 5.0:
                        data = stream.read(device_chunk, exception_on_overflow=False)
                        audio_native = np.frombuffer(data, dtype=np.int16)
                        audio_16k = resampler.resample(audio_native, gain=MIC_GAIN)
                        level = rms_np(audio_16k)
                        if level > SPEECH_THRESHOLD:
                            followup_frames.append(audio_16k)
                            followup_silence = None
                            got_speech = True
                        elif got_speech:
                            if followup_silence is None:
                                followup_silence = time.time()
                            elif time.time() - followup_silence > SILENCE_DURATION:
                                break
                        # Keep buffering even sub-threshold audio during speech
                        elif not got_speech:
                            followup_frames.append(audio_16k)

                    if got_speech:
                        followup_text = transcribe_local(followup_frames)
                        if followup_text and not is_hallucination(followup_text):
                            command = followup_text
                            logger.info(f"Follow-up command: {command!r}")
                        else:
                            logger.info("No usable follow-up speech")
                            notify_dashboard("listening")
                            speech_count = 0
                            continue
                    else:
                        logger.info("No follow-up speech detected")
                        notify_dashboard("listening")
                        speech_count = 0
                        continue

                # --- Have a command — route and send ---
                notify_dashboard("command", {"text": command, "message": "Working on it..."})

                # Status / self-awareness detection
                cmd_lower = command.lower()
                if re.search(r'\b(how are you running|system status|are you ok|status report|what errors|how is the system)\b', cmd_lower):
                    route = {"action": "status", "tier": 1}
                elif re.search(r'\b(what can you do|show.*commands|help|what commands)\b', cmd_lower):
                    route = {"action": "navigate", "params": {"panel": "help"}, "tier": 1}
                else:
                    route = route_command(command)
                if route:
                    logger.info(f"Route: {route['action']} (tier {route.get('tier','?')})")
                _command_queue.put((command, route))
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
