"""Configuration for the Clawd Memory Service.

Uses Pydantic BaseSettings for validation at import time.
All values read from environment variables with sensible defaults.
"""

import os
from enum import Enum
from pydantic_settings import BaseSettings
from pydantic import Field


class MemoryCategory(str, Enum):
    """Valid memory categories — must match Pi-side constants."""
    PREFERENCE = "preference"
    PERSON = "person"
    LEGAL = "legal"
    TRAVEL = "travel"
    ACCOMMODATION = "accommodation"
    HENRY = "henry"
    AI_CONSULTANCY = "ai_consultancy"
    SCHEDULE = "schedule"
    GENERAL = "general"
    IDENTITY = "identity"
    DREAM = "dream"
    SYSTEM = "system"
    INSIGHT = "insight"
    DOCUMENT = "document"
    DOCUMENT_CHUNK = "document_chunk"
    DOCUMENT_INDEX = "document_index"


class Settings(BaseSettings):
    """Validated configuration — fast-fails on startup if env vars are malformed."""

    # LLM backends (llama.cpp servers)
    llm_url: str = Field(default="http://localhost:8080", description="Main model URL")
    llm_embed_url: str = Field(default="http://localhost:8083", description="Embedding model URL")
    embed_model: str = "qwen3-embedding-8b"
    extract_model: str = "qwen3.5:35b"
    extract_temperature: float = 0.1
    vision_model: str = "qwen3.5:35b"

    # Whisper
    whisper_model_size: str = "large-v3"
    whisper_device: str = "auto"
    whisper_compute_type: str = "float16"

    # Data paths
    data_dir: str = Field(default_factory=lambda: os.path.expanduser("~/clawdbot-memory/data"))

    # Server
    memory_service_port: int = 5100

    class Config:
        env_prefix = ""
        case_sensitive = False


# Singleton — validates on import
settings = Settings()

# Derived paths
DATA_DIR = settings.data_dir
MEMORIES_FILE = os.path.join(DATA_DIR, "memories.json")
ARCHIVE_FILE = os.path.join(DATA_DIR, "memories_archive.json")
PROCESSED_DIR = os.path.join(DATA_DIR, "processed")
PORT = settings.memory_service_port

# Backward-compatible module-level constants (existing code imports these directly)
LLM_URL = settings.llm_url
LLM_EMBED_URL = settings.llm_embed_url
EMBED_MODEL = settings.embed_model
EXTRACT_MODEL = settings.extract_model
EXTRACT_TEMPERATURE = settings.extract_temperature
VISION_MODEL = settings.vision_model
WHISPER_MODEL_SIZE = settings.whisper_model_size
WHISPER_DEVICE = settings.whisper_device
WHISPER_COMPUTE_TYPE = settings.whisper_compute_type

# Categories and TTLs
CATEGORIES = [c.value for c in MemoryCategory]

DEFAULT_TTL: dict[str, int] = {
    "preference": 0, "person": 0, "legal": 0,
    "travel": 14, "accommodation": 90, "henry": 30,
    "ai_consultancy": 0, "schedule": 7, "general": 90,
    "identity": 0, "dream": 0, "system": 7,
    "insight": 0, "document": 0, "document_chunk": 90,
    "document_index": 0,
}

EXTRACTION_PROMPT = """You are a memory extraction system for a personal assistant serving James Cockburn, a UK-based solicitor. Extract ALL key facts worth remembering from this conversation.

Rules:
- Output a JSON array of objects: {{"fact": "...", "category": "...", "tags": [...], "confidence": 0.0-1.0}}
- Facts must be concise (max 150 chars), specific, and actionable
- DO NOT extract greetings, filler, or conversational mechanics
- DO NOT extract information that duplicates calendar events or todos
- Attribute actions to the correct person (who did/wants/said what)
- Convert relative dates to absolute dates using today's date: {today}
- Confidence: 0.9+ for explicit statements, 0.7-0.9 for inferences, <0.7 for uncertain

Categories: preference, person, legal, travel, accommodation, henry, ai_consultancy, schedule, general, identity, dream, system, insight

Output ONLY the JSON array. No markdown, no explanation."""
