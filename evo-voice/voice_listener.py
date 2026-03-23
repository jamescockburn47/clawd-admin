"""Voice listener for Clawd — runs on EVO X2.

State machine architecture with guaranteed audio output, timeouts,
and structured logging on every state transition.

States:
  IDLE → RECORDING → TRANSCRIBING → (wake check)
    → ACK_LISTEN (wake-only) → RECORDING (follow-up)
    → ROUTING → WAITING → SPEAKING → FOLLOW_UP → IDLE

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
from enum import Enum, auto
import wave
import time
import logging
import argparse
from math import gcd

import pyaudio
import numpy as np
import requests
from scipy.signal import resample_poly

try:
    from webrtc_noise_gain import AudioProcessor
    _noise_processor = AudioProcessor(3, 3)
    _HAS_NOISE_SUPPRESSION = True
except (ImportError, TypeError):
    _noise_processor = None
    _HAS_NOISE_SUPPRESSION = False


# ══════════════════════════════════════════════════════════════
# State Machine
# ══════════════════════════════════════════════════════════════

class State(Enum):
    IDLE = auto()
    RECORDING = auto()
    TRANSCRIBING = auto()
    ACK_LISTEN = auto()       # Said "Yes?", waiting for follow-up command
    ROUTING = auto()
    WAITING_RESPONSE = auto()
    SPEAKING = auto()
    FOLLOW_UP = auto()        # Post-response listening window


# Timeouts per state (seconds). Every state MUST have a timeout
# except IDLE (infinite wait for speech).
STATE_TIMEOUTS = {
    State.RECORDING: 12.0,
    State.TRANSCRIBING: 5.0,
    State.ACK_LISTEN: 8.0,
    State.ROUTING: 3.0,
    State.WAITING_RESPONSE: 30.0,
    State.SPEAKING: 15.0,      # max audio duration + margin
    State.FOLLOW_UP: 10.0,
}

# What to say on timeout (None = silent return to IDLE)
TIMEOUT_SPEECH = {
    State.TRANSCRIBING: "Sorry, I didn't catch that",
    State.WAITING_RESPONSE: "Sorry, that's taking too long",
    State.SPEAKING: None,      # force-stop, no additional speech
    State.ROUTING: None,       # fall through to Claude
    State.ACK_LISTEN: None,    # no command given, silent return
    State.FOLLOW_UP: None,     # window expired, silent return
}


_current_state = State.IDLE
_state_entered = time.time()


def transition(new_state, context=""):
    """Log state transition with duration."""
    global _current_state, _state_entered
    old = _current_state
    dur_ms = (time.time() - _state_entered) * 1000
    _current_state = new_state
    _state_entered = time.time()
    logger.info(f"[{old.name}] → [{new_state.name}] ({dur_ms:.0f}ms) {context}")


# ══════════════════════════════════════════════════════════════
# Config
# ══════════════════════════════════════════════════════════════

TARGET_RATE = 16000
CHANNELS = 1
FORMAT = pyaudio.paInt16
CHUNK_SAMPLES = 1280  # 80ms at 16kHz

MIC_GAIN = float(os.environ.get("MIC_GAIN", "3.5"))
SPEECH_THRESHOLD = int(os.environ.get("SPEECH_THRESHOLD", "1800"))
SPEECH_CONFIRM_CHUNKS = int(os.environ.get("SPEECH_CONFIRM_CHUNKS", "3"))
SILENCE_THRESHOLD = int(os.environ.get("SILENCE_THRESHOLD", "700"))
SILENCE_DURATION = float(os.environ.get("SILENCE_DURATION", "0.8"))  # 0.8s — tighter than 1.2
MAX_RECORD_SECONDS = float(os.environ.get("MAX_RECORD_SECONDS", "12"))
MIN_RECORD_SECONDS = float(os.environ.get("MIN_RECORD_SECONDS", "0.5"))
COOLDOWN = float(os.environ.get("COOLDOWN", "1.0"))

# Prefer Pi direct Ethernet 10.0.0.1 when link is up; set CLAWDBOT_URL if using WiFi only
CLAWDBOT_URL = os.environ.get("CLAWDBOT_URL", "http://10.0.0.1:3000")
DASHBOARD_TOKEN = os.environ.get("DASHBOARD_TOKEN", "VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM")
ROUTE_URL = os.environ.get("ROUTE_URL", "http://localhost:5100/route-command")
DEVICE_INDEX = os.environ.get("AUDIO_DEVICE_INDEX", "usb")

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("voice-listener")
os.environ.setdefault("PYTHONWARNINGS", "ignore")


# ══════════════════════════════════════════════════════════════
# Contacts & vocabulary biasing
# ══════════════════════════════════════════════════════════════

CONTACTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "contacts.json")
_contacts = {}
_corrections = {}
_whisper_prompt = ""


def _load_contacts():
    global _contacts, _corrections, _whisper_prompt
    try:
        with open(CONTACTS_FILE) as f:
            _contacts = json.load(f)
    except FileNotFoundError:
        logger.warning(f"No contacts file: {CONTACTS_FILE}")
        return

    names = set()
    for c in _contacts.get("contacts", []):
        names.add(c["name"])
        for alias in c.get("aliases", []):
            names.add(alias)

    owner = _contacts.get("owner", "James")
    all_names = sorted(names)
    # CRITICAL: include wake phrases in initial_prompt for Whisper decoder biasing
    _whisper_prompt = (
        f"Hey Claude, hey Clawd. {owner} is talking to Claude. "
        f"Names: {', '.join(all_names)}. "
        "Hey Claude, what's happening today? Hey Claude, add a todo."
    )

    _corrections = {
        "mj": "MG", "m.j.": "MG", "m j": "MG",
        "emg": "MG", "m.g.": "MG", "mg": "MG",
    }
    logger.info(f"Contacts loaded: {len(all_names)} names, prompt: {_whisper_prompt!r}")


def _apply_corrections(text):
    if not _corrections:
        return text
    for wrong, right in _corrections.items():
        text = re.sub(r'\b' + re.escape(wrong) + r'\b', right, text, flags=re.IGNORECASE)
    return text


# ══════════════════════════════════════════════════════════════
# Wake phrase detection
# ══════════════════════════════════════════════════════════════

GRATITUDE_PHRASES = {
    "thank you", "thanks", "cheers", "ta", "nice one",
    "good job", "well done", "great", "perfect", "brilliant",
    "okay thanks", "ok thanks", "thank you very much",
}

WHISPER_HALLUCINATIONS = {
    "thank you", "thanks", "thank you for watching", "bye", "goodbye",
    "you", "the", "i", "it", "a", "so", "yeah", "yes", "no", "okay",
    "um", "uh", "hmm", "mm", "oh", "ah", "ha",
    "thank you very much", "thanks for watching",
    "i'm going to", "subscribe", "like and subscribe",
    "music", "applause", "laughter",
}


def is_hallucination(text):
    if not text:
        return True
    cleaned = text.strip().lower().rstrip(".!?,")
    if cleaned in WHISPER_HALLUCINATIONS:
        return True
    if len(cleaned.split()) == 1 and len(cleaned) < 4:
        return True
    return False


def _levenshtein(a, b):
    """Simple Levenshtein distance for fuzzy wake phrase matching."""
    if len(a) < len(b):
        return _levenshtein(b, a)
    if len(b) == 0:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        curr = [i + 1]
        for j, cb in enumerate(b):
            curr.append(min(prev[j + 1] + 1, curr[j] + 1, prev[j] + (ca != cb)))
        prev = curr
    return prev[-1]


def has_wake_phrase(text: str) -> bool:
    """Check if text contains the wake phrase. Uses regex + fuzzy matching."""
    head = text[:45].lower()
    # Tier 1: unambiguous — "claude/clawd" variants always match
    if re.search(r"\b(clawd|claude?|clawed|klawd|klaud)\b", head):
        return True
    # Tier 2: ambiguous words that only count with a prefix
    if re.search(r"\b(hey|hay|take|heck|a|eh|ok)\s+\w*\s*(lord|cloud|load|clod|cord)\b", head):
        return True
    # Tier 3: single-word mishearings
    if re.search(r"^accord\b", head):
        return True
    # Tier 4: fuzzy match — check first 2 words against "hey claude"
    words = head.split()[:3]
    if len(words) >= 2:
        phrase = " ".join(words[:2])
        if _levenshtein(phrase, "hey claude") <= 3:
            return True
        if _levenshtein(phrase, "hey clawd") <= 3:
            return True
    return False


def strip_wake_phrase(text):
    cleaned = re.sub(
        r"^(hey|hay|eh|a|ok|okay|i'?m|i am|take|heck|uh)?\s*,?\s*(clawd|claude?|clawed|klawd|klaud|cloud|claw|lord|cord|accord|load|clod)\b[.,!?\s]*",
        "", text, flags=re.IGNORECASE
    ).strip()
    return cleaned


# ══════════════════════════════════════════════════════════════
# Audio helpers
# ══════════════════════════════════════════════════════════════

def denoise_audio(audio_16k):
    if not _HAS_NOISE_SUPPRESSION or _noise_processor is None:
        return audio_16k
    chunk_size = 160  # 10ms at 16kHz
    out_chunks = []
    for i in range(0, len(audio_16k), chunk_size):
        chunk = audio_16k[i:i + chunk_size]
        if len(chunk) < chunk_size:
            chunk = np.pad(chunk, (0, chunk_size - len(chunk)))
        result = _noise_processor.Process10ms(chunk.tobytes())
        out_chunks.append(np.frombuffer(result.audio, dtype=np.int16))
    return np.concatenate(out_chunks)[:len(audio_16k)]


def find_usb_mic(pa):
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


# ══════════════════════════════════════════════════════════════
# Whisper (local, in-process)
# ══════════════════════════════════════════════════════════════

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "distil-small.en")
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
    all_audio = np.concatenate(frames_16k)
    chunk_size = CHUNK_SAMPLES
    n_chunks = len(all_audio) // chunk_size
    if n_chunks < 2:
        return frames_16k
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
    start = max(0, first_speech - 1) * chunk_size
    end = min(n_chunks, last_speech + 2) * chunk_size
    trimmed = all_audio[start:end]
    if len(trimmed) < chunk_size:
        return frames_16k
    return [trimmed]


def transcribe_local(frames_16k):
    trimmed = trim_silence(frames_16k)
    audio = np.concatenate(trimmed).astype(np.float32) / 32768.0
    model = get_whisper()
    segments, info = model.transcribe(
        audio,
        beam_size=5,
        language="en",
        vad_filter=True,
        vad_parameters=dict(onset=0.1, min_speech_duration_ms=150),
        initial_prompt=_whisper_prompt or None,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    text = _apply_corrections(text)
    logger.info(f"Whisper ({info.duration:.1f}s, trimmed {len(audio)/16000:.1f}s): {text!r}")
    return text if text else None


# ══════════════════════════════════════════════════════════════
# TTS — Piper only (Decision #1: Orpheus disabled)
# ══════════════════════════════════════════════════════════════

TTS_MODEL = os.environ.get("TTS_MODEL", os.path.expanduser("~/clawdbot-memory/tts-voices/en_GB-alan-medium.onnx"))
_piper_voice = None


def get_piper():
    global _piper_voice
    if _piper_voice is None:
        if not os.path.exists(TTS_MODEL):
            return None
        from piper import PiperVoice
        _piper_voice = PiperVoice.load(TTS_MODEL)
        logger.info(f"Piper loaded: {TTS_MODEL}")
    return _piper_voice


def _send_audio_to_dashboard(audio_bytes, sr, label, text):
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
    """Piper TTS. Returns audio duration in seconds."""
    voice = get_piper()
    if not voice:
        logger.error("Piper not loaded — no audio output")
        return 0.0
    try:
        chunks = list(voice.synthesize(text))
        audio_bytes = b"".join(c.audio_int16_bytes for c in chunks)
        sr = chunks[0].sample_rate
        _send_audio_to_dashboard(audio_bytes, sr, "Piper", text)
        return len(audio_bytes) / 2 / sr
    except Exception as e:
        logger.error(f"Piper TTS error: {e}")
        return 0.0


def speak(text):
    """All TTS goes through Piper. Decision #1."""
    return speak_fast(text)


def speak_error(msg="Sorry, something went wrong"):
    """Guaranteed error speech — catches its own exceptions."""
    try:
        speak_fast(msg)
    except Exception:
        pass


# ══════════════════════════════════════════════════════════════
# Network helpers
# ══════════════════════════════════════════════════════════════

def route_command(text):
    try:
        resp = requests.post(ROUTE_URL, json={"text": text}, timeout=STATE_TIMEOUTS[State.ROUTING])
        if resp.status_code == 200:
            return resp.json()
    except Exception as e:
        logger.error(f"Route error: {e}")
    return None


def send_to_clawdbot(text, route=None):
    """Send command to Pi. Returns response dict or False on failure."""
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
                logger.info(f"Local: {route['action']} (tier {route.get('tier','?')})")
                try:
                    return resp.json()
                except Exception:
                    return {"ok": True, "message": "Done"}
            else:
                logger.error(f"voice-local {resp.status_code}: {resp.text[:200]}")
                # Fall through to Claude

        resp = requests.post(
            f"{CLAWDBOT_URL}/api/voice-command",
            json={"text": text, "source": "wake_word"},
            headers={"Authorization": f"Bearer {DASHBOARD_TOKEN}"},
            timeout=STATE_TIMEOUTS[State.WAITING_RESPONSE],
        )
        if resp.status_code == 200:
            logger.info(f"Claude: {text!r}")
            try:
                return resp.json()
            except Exception:
                return {"ok": True, "message": "Done"}
        else:
            logger.error(f"Clawdbot {resp.status_code}: {resp.text[:200]}")
            return False
    except requests.Timeout:
        logger.error("Clawdbot request timed out")
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


# ══════════════════════════════════════════════════════════════
# Mic flush helper
# ══════════════════════════════════════════════════════════════

def flush_mic(stream, device_chunk, duration_secs):
    """Drain mic buffer after TTS to prevent bleed-through.
    Waits for audio to finish playing, then drains stale frames."""
    flush_wait = max(duration_secs + 0.5, 1.5)
    logger.debug(f"Flushing mic for {flush_wait:.1f}s (audio={duration_secs:.1f}s)")
    time.sleep(flush_wait)
    try:
        while stream.get_read_available() > device_chunk:
            stream.read(device_chunk, exception_on_overflow=False)
    except Exception:
        pass


# ══════════════════════════════════════════════════════════════
# Command worker (background thread)
# ══════════════════════════════════════════════════════════════

import threading
import queue

_command_queue = queue.Queue()
_followup_mode = threading.Event()
_followup_deadline = 0.0

# Quick-ack actions: simple confirmation, no interpretation needed
QUICK_ACK_ACTIONS = {
    "navigate": lambda p: f"Showing {p.get('panel', 'dashboard')}",
    "todo_add": lambda p: "Added",
    "todo_complete": lambda p: "Done",
    "refresh": lambda p: "Refreshed",
    "remember": lambda p: "Noted",
}


def _extract_speakable_text(result):
    """Extract speakable text from any API response. Never returns empty."""
    if not isinstance(result, dict):
        return "Done"
    text = result.get("response") or result.get("message") or ""
    if not text:
        return "Done"
    # Truncate to first 3 sentences or 300 chars
    sentences = re.split(r'(?<=[.!?])\s+', text)
    tts_text = " ".join(sentences[:3])
    if len(tts_text) > 300:
        tts_text = tts_text[:297] + "..."
    # Strip markdown
    tts_text = re.sub(r'\*\*?([^*]+)\*\*?', r'\1', tts_text)
    tts_text = re.sub(r'[*_`#\[\]]', '', tts_text)
    # Strip emoji
    tts_text = re.sub(r'[\U0001f300-\U0001f9ff]', '', tts_text)
    return tts_text.strip() or "Done"


def _command_worker():
    """Background thread: route, wait for response, speak result.
    INVARIANT: every command produces audible output."""
    global _followup_deadline
    while True:
        try:
            command, route_result = _command_queue.get(timeout=1)
        except queue.Empty:
            continue

        tts_dur = 0.0
        try:
            _followup_mode.clear()
            notify_dashboard("command", {"text": command})

            # --- ROUTING ---
            transition(State.ROUTING, f"cmd={command!r}")

            # --- WAITING_RESPONSE ---
            transition(State.WAITING_RESPONSE)
            result = send_to_clawdbot(command, route_result)
            # Pi SSE emits the real "response" event — no separate EVO "result" (avoids dashboard noop traffic)

            # --- SPEAKING ---
            transition(State.SPEAKING)

            action = route_result.get("action", "") if route_result else ""
            params = route_result.get("params", {}) if route_result else {}
            went_to_claude = not route_result or action == "claude"

            if result is False:
                # API call failed — tell the user
                tts_dur = speak_fast("Sorry, I couldn't get an answer")
            elif not went_to_claude and action in QUICK_ACK_ACTIONS:
                tts_dur = speak_fast(QUICK_ACK_ACTIONS[action](params))
            else:
                # Claude response OR any local action with substantive output
                tts_text = _extract_speakable_text(result)
                tts_dur = speak(tts_text) or 0.0

            # Decision #2: every command MUST produce audible output
            if tts_dur <= 0:
                tts_dur = speak_fast("Done")

        except Exception as e:
            logger.error(f"Command worker error: {e}")
            speak_error()

        # --- Post-speech: flush mic and enter follow-up mode ---
        # Decision #3 & #4: flush after ALL TTS, follow-up after ALL responses
        if tts_dur > 0:
            transition(State.FOLLOW_UP, f"tts={tts_dur:.1f}s")
            _followup_deadline = time.time() + tts_dur + 0.5 + STATE_TIMEOUTS[State.FOLLOW_UP]
            _followup_mode.set()
            logger.info(f"Follow-up mode: {STATE_TIMEOUTS[State.FOLLOW_UP]:.0f}s window")
        else:
            transition(State.IDLE)
            notify_dashboard("listening")

        _command_queue.task_done()


# ══════════════════════════════════════════════════════════════
# Main loop
# ══════════════════════════════════════════════════════════════

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

    # --- Startup ---
    _load_contacts()
    logger.info("Pre-loading Whisper + TTS...")
    get_whisper()
    get_piper()  # Decision #1: Piper for all TTS

    # Heartbeat thread
    _voice_start_time = time.time()

    def _heartbeat():
        while True:
            try:
                uptime = int(time.time() - _voice_start_time)
                notify_dashboard("heartbeat", {
                    "uptime": uptime,
                    "noise_suppression": _HAS_NOISE_SUPPRESSION,
                    "whisper_model": WHISPER_MODEL,
                    "state": _current_state.name,
                })
            except Exception:
                pass
            time.sleep(60)

    threading.Thread(target=_heartbeat, daemon=True).start()
    logger.info("Heartbeat started (60s interval)")

    # Command worker thread
    threading.Thread(target=_command_worker, daemon=True).start()

    # Open mic stream
    stream = pa.open(format=FORMAT, channels=CHANNELS, rate=native_rate,
                     input=True, input_device_index=dev_idx, frames_per_buffer=device_chunk)

    logger.info(f"Listening: device={dev_idx}, rate={native_rate}Hz, gain={MIC_GAIN}x, "
                f"speech={SPEECH_THRESHOLD}, silence={SILENCE_THRESHOLD}, "
                f"silence_dur={SILENCE_DURATION}s, "
                f"noise_suppression={'on' if _HAS_NOISE_SUPPRESSION else 'off'}")
    notify_dashboard("listening")
    transition(State.IDLE)

    last_detection = 0
    speech_count = 0
    PRE_BUFFER_CHUNKS = 10  # ~800ms at 80ms/chunk
    pre_buffer = deque(maxlen=PRE_BUFFER_CHUNKS)

    try:
        while True:
            data = stream.read(device_chunk, exception_on_overflow=False)
            audio_native = np.frombuffer(data, dtype=np.int16)
            audio_16k = resampler.resample(audio_native, gain=MIC_GAIN)
            audio_16k = denoise_audio(audio_16k)
            level = rms_np(audio_16k)
            pre_buffer.append(audio_16k)

            # --- Check follow-up expiry ---
            if _followup_mode.is_set() and time.time() >= _followup_deadline:
                _followup_mode.clear()
                transition(State.IDLE, "follow-up expired")
                notify_dashboard("listening")

            # --- Speech detection ---
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

            # ── RECORDING ──
            transition(State.RECORDING, f"RMS={level:.0f}")
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
                        break
                else:
                    silence_start = None

                if elapsed > MAX_RECORD_SECONDS:
                    break

            if elapsed < MIN_RECORD_SECONDS:
                transition(State.IDLE, "too short")
                speech_count = 0
                continue

            # ── TRANSCRIBING ──
            transition(State.TRANSCRIBING)
            t0 = time.time()
            text = transcribe_local(frames_16k)
            transcribe_ms = (time.time() - t0) * 1000
            logger.info(f"Transcription: {transcribe_ms:.0f}ms")

            if not text or is_hallucination(text):
                if text:
                    logger.info(f"Rejected hallucination: {text!r}")
                transition(State.IDLE, "no valid speech")
                notify_dashboard("listening")
                speech_count = 0
                continue

            # ── FOLLOW-UP MODE: no wake phrase needed ──
            in_followup = _followup_mode.is_set() and time.time() < _followup_deadline
            if in_followup:
                _followup_mode.clear()
                command = text.strip()
                logger.info(f"Follow-up: {command!r}")
                if command:
                    route = route_command(command)
                    if route:
                        logger.info(f"Route: {route['action']} (tier {route.get('tier','?')})")
                    _command_queue.put((command, route))
                else:
                    transition(State.IDLE, "empty follow-up")
                speech_count = 0
                continue

            # ── WAKE PHRASE CHECK ──
            if has_wake_phrase(text):
                last_detection = time.time()
                command = strip_wake_phrase(text)
                logger.info(f"Wake! Command: {command!r}")

                # Gratitude
                if command and command.lower().rstrip(".,!? ") in GRATITUDE_PHRASES:
                    speak_fast("You're welcome")
                    transition(State.IDLE, "gratitude")
                    flush_mic(stream, device_chunk, 1.0)
                    notify_dashboard("listening")
                    speech_count = 0
                    continue

                if not command:
                    # ── ACK_LISTEN: wake word only ──
                    transition(State.ACK_LISTEN)
                    ack_dur = speak_fast("Yes?")  # Decision #6
                    flush_mic(stream, device_chunk, ack_dur)

                    # Listen for follow-up command
                    followup_frames = []
                    followup_start = time.time()
                    followup_silence = None
                    got_speech = False

                    while time.time() - followup_start < STATE_TIMEOUTS[State.ACK_LISTEN]:
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
                        elif not got_speech:
                            followup_frames.append(audio_16k)

                    if got_speech:
                        transition(State.TRANSCRIBING, "follow-up")
                        followup_text = transcribe_local(followup_frames)
                        if followup_text and not is_hallucination(followup_text):
                            command = followup_text
                            logger.info(f"Follow-up command: {command!r}")
                        else:
                            logger.info("No usable follow-up speech")
                            transition(State.IDLE, "bad follow-up")
                            notify_dashboard("listening")
                            speech_count = 0
                            continue
                    else:
                        logger.info("No follow-up speech detected")
                        transition(State.IDLE, "no follow-up")
                        notify_dashboard("listening")
                        speech_count = 0
                        continue

                # ── Route and enqueue ──
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
                transition(State.IDLE)
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
