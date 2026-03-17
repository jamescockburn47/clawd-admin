"""Train a custom "hey clawd" wake word verifier for openWakeWord.

Loads positive and negative WAV samples recorded by record_samples.py,
trains a custom verifier model, and saves it as a .tflite file.

Usage:
    python3 train_wake_word.py
    python3 train_wake_word.py --training-dir ~/clawdbot-voice/training
    python3 train_wake_word.py --test  # train and test against first sample

Requires: openwakeword, numpy, scipy
"""

import os
import sys
import wave
import argparse
from math import gcd
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

# --- Config ---
TARGET_RATE = 16000
NATIVE_RATE = 44100

_d = gcd(NATIVE_RATE, TARGET_RATE)
UP = TARGET_RATE // _d
DOWN = NATIVE_RATE // _d


def load_wav(filepath):
    """Load a WAV file and return int16 numpy array at TARGET_RATE.

    If the file is not at TARGET_RATE, resample it.
    """
    with wave.open(str(filepath), "rb") as wf:
        assert wf.getnchannels() == 1, f"Expected mono, got {wf.getnchannels()} channels"
        assert wf.getsampwidth() == 2, f"Expected 16-bit, got {wf.getsampwidth() * 8}-bit"
        rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())

    audio = np.frombuffer(frames, dtype=np.int16)

    if rate != TARGET_RATE:
        d = gcd(rate, TARGET_RATE)
        up = TARGET_RATE // d
        down = rate // d
        float_audio = audio.astype(np.float64)
        audio = np.clip(resample_poly(float_audio, up, down), -32768, 32767).astype(np.int16)

    return audio


def load_samples(sample_dir):
    """Load all WAV files from a directory, return list of int16 arrays."""
    sample_dir = Path(sample_dir)
    if not sample_dir.exists():
        return []

    samples = []
    wav_files = sorted(sample_dir.glob("*.wav"))
    for wav_path in wav_files:
        try:
            audio = load_wav(wav_path)
            samples.append(audio)
            print(f"  Loaded: {wav_path.name} ({len(audio)} samples, RMS={rms(audio):.0f})")
        except Exception as e:
            print(f"  SKIP: {wav_path.name} -- {e}")

    return samples


def rms(audio_int16):
    """RMS level of int16 audio."""
    if len(audio_int16) == 0:
        return 0.0
    return float(np.sqrt(np.mean(audio_int16.astype(np.float64) ** 2)))


def test_model(model_path, test_audio):
    """Load the trained model and run a test prediction."""
    from openwakeword.model import Model as OWWModel

    print(f"\n--- Testing model ---")
    print(f"Model: {model_path}")
    print(f"Test audio: {len(test_audio)} samples ({len(test_audio) / TARGET_RATE:.2f}s)")

    oww = OWWModel(wakeword_models=[str(model_path)])

    # Feed audio in 1280-sample chunks (80ms at 16kHz) as openWakeWord expects
    chunk_size = 1280
    max_score = 0.0
    detections = 0

    for i in range(0, len(test_audio) - chunk_size, chunk_size):
        chunk = test_audio[i:i + chunk_size]
        oww.predict(chunk)

        for model_name, scores in oww.prediction_buffer.items():
            if len(scores) > 0:
                score = scores[-1]
                if score > max_score:
                    max_score = score
                if score > 0.5:
                    detections += 1

    print(f"Max score: {max_score:.4f}")
    print(f"Detections (>0.5): {detections}")

    if max_score > 0.5:
        print("PASS -- Model detected wake word in test sample")
    elif max_score > 0.3:
        print("MARGINAL -- Model partially detected wake word (score 0.3-0.5)")
        print("  Consider recording more samples and retraining")
    else:
        print("FAIL -- Model did not detect wake word in test sample")
        print("  Try recording more/clearer samples and retrain")

    return max_score


def main():
    parser = argparse.ArgumentParser(description="Train custom hey clawd wake word model")
    parser.add_argument("--training-dir", type=str,
                        default=os.path.expanduser("~/clawdbot-voice/training"),
                        help="Directory containing positive/ and negative/ WAV samples")
    parser.add_argument("--output", type=str,
                        default=os.path.expanduser("~/clawdbot-voice/models/hey_clawd.tflite"),
                        help="Output model path")
    parser.add_argument("--test", action="store_true",
                        help="Test the model against the first positive sample after training")
    parser.add_argument("--test-only", type=str, default=None,
                        help="Skip training, just test existing model against a WAV file")
    args = parser.parse_args()

    # Test-only mode
    if args.test_only:
        model_path = Path(args.output)
        if not model_path.exists():
            print(f"Model not found: {model_path}")
            sys.exit(1)
        test_audio = load_wav(args.test_only)
        test_model(model_path, test_audio)
        return

    training_dir = Path(args.training_dir)
    pos_dir = training_dir / "positive"
    neg_dir = training_dir / "negative"
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Load samples
    print("Loading positive samples...")
    positive_samples = load_samples(pos_dir)
    print(f"\nLoading negative samples...")
    negative_samples = load_samples(neg_dir)

    print(f"\nSamples loaded: {len(positive_samples)} positive, {len(negative_samples)} negative")

    if len(positive_samples) < 3:
        print("\nERROR: Need at least 3 positive samples (10+ recommended).")
        print("Run record_samples.py first.")
        sys.exit(1)

    if len(negative_samples) < 1:
        print("\nERROR: Need at least 1 negative sample (5+ recommended).")
        print("Run record_samples.py first.")
        sys.exit(1)

    # Normalize all samples to same length (pad/trim to 2 seconds at 16kHz)
    target_len = TARGET_RATE * 2  # 2 seconds
    def normalize_length(audio, target=target_len):
        if len(audio) >= target:
            return audio[:target]
        else:
            return np.pad(audio, (0, target - len(audio)), mode="constant")

    positive_clips = [normalize_length(s) for s in positive_samples]
    negative_clips = [normalize_length(s) for s in negative_samples]

    # Convert to float32 arrays as expected by openwakeword training
    positive_float = [clip.astype(np.float32) / 32768.0 for clip in positive_clips]
    negative_float = [clip.astype(np.float32) / 32768.0 for clip in negative_clips]

    # Train using openwakeword's custom verifier
    print(f"\nTraining custom verifier model...")
    print(f"  Positive clips: {len(positive_float)}")
    print(f"  Negative clips: {len(negative_float)}")

    try:
        from openwakeword import train_custom_verifier

        train_custom_verifier.train(
            positive_reference_clips=positive_float,
            negative_reference_clips=negative_float,
            output_path=str(output_path),
            model_name="hey_clawd",
        )

        print(f"\nModel saved to: {output_path}")
        print(f"File size: {output_path.stat().st_size} bytes")

    except ImportError:
        print("\nERROR: openwakeword.train_custom_verifier not available.")
        print("Make sure openwakeword >= 0.6.0 is installed:")
        print("  pip install openwakeword>=0.6.0")
        sys.exit(1)
    except TypeError as e:
        # API may differ between versions; try alternative signatures
        print(f"\nFirst attempt failed ({e}), trying alternative API...")
        try:
            from openwakeword.custom_verifier_model import train_verifier_model

            train_verifier_model(
                positive_reference_clips=positive_float,
                negative_reference_clips=negative_float,
                output_path=str(output_path),
            )
            print(f"\nModel saved to: {output_path}")
            print(f"File size: {output_path.stat().st_size} bytes")
        except Exception as e2:
            print(f"\nERROR: Training failed: {e2}")
            print("Check openwakeword version and API docs.")
            sys.exit(1)
    except Exception as e:
        print(f"\nERROR: Training failed: {e}")
        sys.exit(1)

    # Optional test
    if args.test and len(positive_clips) > 0:
        test_model(output_path, positive_clips[0])

    print(f"\nDone. To use this model, set:")
    print(f"  export WAKE_MODEL_PATH={output_path}")
    print(f"Or copy to ~/clawdbot-voice/models/hey_clawd.tflite")
    print(f"Then restart wake_listener.py")


if __name__ == "__main__":
    main()
