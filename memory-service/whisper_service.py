"""Whisper transcription service using faster-whisper."""

import io
import logging
import tempfile
import os

import config

logger = logging.getLogger("memory-service.whisper")

_model = None


def get_model():
    """Lazy-load the Whisper model."""
    global _model
    if _model is not None:
        return _model

    try:
        from faster_whisper import WhisperModel
        logger.info(f"Loading Whisper model: {config.WHISPER_MODEL_SIZE} "
                     f"(device={config.WHISPER_DEVICE}, compute={config.WHISPER_COMPUTE_TYPE})")
        _model = WhisperModel(
            config.WHISPER_MODEL_SIZE,
            device=config.WHISPER_DEVICE,
            compute_type=config.WHISPER_COMPUTE_TYPE,
        )
        logger.info("Whisper model loaded successfully")
        return _model
    except Exception as e:
        logger.error(f"Failed to load Whisper model: {e}")
        raise


def transcribe(audio_bytes: bytes, language: str = "en") -> dict:
    """Transcribe audio bytes to text."""
    model = get_model()

    # Write to temp file (faster-whisper needs a file path)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(
            tmp_path,
            language=language,
            beam_size=5,
            vad_filter=True,
        )

        text_parts = []
        for segment in segments:
            text_parts.append(segment.text.strip())

        full_text = " ".join(text_parts)

        return {
            "text": full_text,
            "language": info.language,
            "language_probability": round(info.language_probability, 3),
            "duration": round(info.duration, 2),
        }
    finally:
        os.unlink(tmp_path)


def is_available() -> bool:
    """Check if Whisper is available."""
    try:
        from faster_whisper import WhisperModel
        return True
    except ImportError:
        return False


def is_loaded() -> bool:
    """Check if the model is loaded."""
    return _model is not None
