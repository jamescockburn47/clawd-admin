"""Record training samples for custom "hey clawd" wake word.

Records 2-second clips from USB mic at 44100Hz, resamples to 16kHz mono WAV.
Saves positive samples (user saying "hey clawd") and negative samples
(silence/background noise) for training a custom openWakeWord verifier.

Usage:
    python3 record_samples.py
    python3 record_samples.py --positive 15 --negative 10
    python3 record_samples.py --output-dir /custom/path

Requires: pyaudio, numpy, scipy
"""

import os
import sys
import wave
import time
import argparse
from math import gcd
from pathlib import Path

import pyaudio
import numpy as np
from scipy.signal import resample_poly

# --- Config ---
DEVICE_INDEX = int(os.environ.get("AUDIO_DEVICE_INDEX", "1"))
NATIVE_RATE = 44100
TARGET_RATE = 16000
CHANNELS = 1
FORMAT = pyaudio.paInt16
RECORD_SECONDS = 2.0
COUNTDOWN_SECONDS = 3

# Resampling factors
_d = gcd(NATIVE_RATE, TARGET_RATE)
UP = TARGET_RATE // _d
DOWN = NATIVE_RATE // _d

# Chunk size: ~50ms at native rate
CHUNK = int(NATIVE_RATE * 0.05)


def resample_audio(audio_int16):
    """Resample int16 numpy array from NATIVE_RATE to TARGET_RATE."""
    float_audio = audio_int16.astype(np.float64)
    resampled = resample_poly(float_audio, UP, DOWN)
    return np.clip(resampled, -32768, 32767).astype(np.int16)


def rms(audio_int16):
    """RMS level of int16 audio."""
    if len(audio_int16) == 0:
        return 0.0
    return float(np.sqrt(np.mean(audio_int16.astype(np.float64) ** 2)))


def save_wav(filepath, audio_int16, sample_rate=TARGET_RATE):
    """Save int16 numpy array as mono WAV file."""
    with wave.open(str(filepath), "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(audio_int16.tobytes())


def record_clip(pa, duration=RECORD_SECONDS):
    """Record a clip at native rate, resample to 16kHz, return int16 array."""
    stream = pa.open(
        format=FORMAT,
        channels=CHANNELS,
        rate=NATIVE_RATE,
        input=True,
        input_device_index=DEVICE_INDEX,
        frames_per_buffer=CHUNK,
    )

    chunks_needed = int(NATIVE_RATE * duration / CHUNK)
    frames = []

    for i in range(chunks_needed):
        data = stream.read(CHUNK, exception_on_overflow=False)
        audio = np.frombuffer(data, dtype=np.int16)
        frames.append(audio)

        # Show live RMS level
        level = rms(audio)
        bars = int(level / 100)
        bar_str = "|" * min(bars, 40)
        print(f"\r  Recording... [{bar_str:40s}] RMS={level:.0f}", end="", flush=True)

    stream.stop_stream()
    stream.close()
    print()

    # Concatenate and resample
    raw = np.concatenate(frames)
    resampled = resample_audio(raw)
    return resampled


def countdown(label, seconds=COUNTDOWN_SECONDS):
    """Visual countdown before recording."""
    print(f"\n{'=' * 50}")
    print(f"  {label}")
    print(f"{'=' * 50}")
    for i in range(seconds, 0, -1):
        print(f"  >>> {i}...", flush=True)
        time.sleep(1)
    print("  >>> RECORDING NOW <<<")


def test_mic(pa):
    """Quick mic test showing RMS levels for 2 seconds."""
    print(f"\nTesting mic (device {DEVICE_INDEX}, {NATIVE_RATE}Hz)...")
    stream = pa.open(
        format=FORMAT,
        channels=CHANNELS,
        rate=NATIVE_RATE,
        input=True,
        input_device_index=DEVICE_INDEX,
        frames_per_buffer=CHUNK,
    )

    chunks_per_sec = NATIVE_RATE // CHUNK
    for _ in range(2 * chunks_per_sec):
        data = stream.read(CHUNK, exception_on_overflow=False)
        audio = np.frombuffer(data, dtype=np.int16)
        level = rms(audio)
        bars = int(level / 100)
        print(f"\r  Level: [{'|' * min(bars, 40):40s}] {level:.0f}", end="", flush=True)

    stream.stop_stream()
    stream.close()
    print("\n  Mic OK.\n")


def main():
    parser = argparse.ArgumentParser(description="Record training samples for hey clawd wake word")
    parser.add_argument("--positive", type=int, default=10, help="Number of positive samples (default: 10)")
    parser.add_argument("--negative", type=int, default=5, help="Number of negative samples (default: 5)")
    parser.add_argument("--output-dir", type=str, default=os.path.expanduser("~/clawdbot-voice/training"),
                        help="Output directory (default: ~/clawdbot-voice/training)")
    parser.add_argument("--device", type=int, default=None, help="Override audio device index")
    args = parser.parse_args()

    global DEVICE_INDEX
    if args.device is not None:
        DEVICE_INDEX = args.device

    pos_dir = Path(args.output_dir) / "positive"
    neg_dir = Path(args.output_dir) / "negative"
    pos_dir.mkdir(parents=True, exist_ok=True)
    neg_dir.mkdir(parents=True, exist_ok=True)

    # Count existing samples to avoid overwriting
    existing_pos = len(list(pos_dir.glob("*.wav")))
    existing_neg = len(list(neg_dir.glob("*.wav")))

    pa = pyaudio.PyAudio()

    # Show device info
    try:
        info = pa.get_device_info_by_index(DEVICE_INDEX)
        print(f"Using device [{DEVICE_INDEX}]: {info['name']}")
        print(f"  Native rate: {NATIVE_RATE}Hz -> Resampling to {TARGET_RATE}Hz")
        print(f"  Resample factors: up={UP}, down={DOWN}")
    except Exception as e:
        print(f"Error accessing device {DEVICE_INDEX}: {e}")
        pa.terminate()
        sys.exit(1)

    # Test mic first
    test_mic(pa)

    print(f"Output directory: {args.output_dir}")
    print(f"Existing samples: {existing_pos} positive, {existing_neg} negative")
    print(f"Will record: {args.positive} positive + {args.negative} negative")
    print(f"Each clip: {RECORD_SECONDS}s at {TARGET_RATE}Hz mono")
    input("\nPress Enter to start recording positive samples...")

    # --- Positive samples ---
    print(f"\n{'#' * 50}")
    print(f"  POSITIVE SAMPLES: Say 'hey clawd' clearly")
    print(f"{'#' * 50}")

    for i in range(args.positive):
        sample_num = existing_pos + i + 1
        countdown(f"Positive sample {i + 1}/{args.positive} -- Say 'HEY CLAWD'")

        audio = record_clip(pa)
        level = rms(audio)
        filepath = pos_dir / f"hey_clawd_{sample_num:03d}.wav"
        save_wav(filepath, audio)
        print(f"  Saved: {filepath} (RMS={level:.0f}, samples={len(audio)})")

        if level < 200:
            print("  WARNING: Very low audio level -- speak louder or check mic")

        if i < args.positive - 1:
            time.sleep(0.5)

    # --- Negative samples ---
    print(f"\n{'#' * 50}")
    print(f"  NEGATIVE SAMPLES: Stay quiet / background noise only")
    print(f"{'#' * 50}")
    input("\nPress Enter to start recording negative (silence) samples...")

    for i in range(args.negative):
        sample_num = existing_neg + i + 1
        countdown(f"Negative sample {i + 1}/{args.negative} -- STAY QUIET")

        audio = record_clip(pa)
        level = rms(audio)
        filepath = neg_dir / f"negative_{sample_num:03d}.wav"
        save_wav(filepath, audio)
        print(f"  Saved: {filepath} (RMS={level:.0f}, samples={len(audio)})")

        if i < args.negative - 1:
            time.sleep(0.5)

    # --- Summary ---
    total_pos = len(list(pos_dir.glob("*.wav")))
    total_neg = len(list(neg_dir.glob("*.wav")))
    print(f"\n{'=' * 50}")
    print(f"  DONE")
    print(f"  Positive samples: {total_pos} (in {pos_dir})")
    print(f"  Negative samples: {total_neg} (in {neg_dir})")
    print(f"{'=' * 50}")

    if total_pos < 10:
        print(f"\n  NOTE: {total_pos} positive samples recorded. 10+ recommended.")
        print(f"  Run again with --positive {10 - total_pos} to add more.")

    print(f"\nNext step: python3 train_wake_word.py")

    pa.terminate()


if __name__ == "__main__":
    main()
