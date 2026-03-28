"""Configuration for the Clawd Memory Service."""

import os

# --- LLM backends (llama.cpp servers) ---
LLM_URL = os.environ.get("LLM_URL", "http://localhost:8080")           # Main model (Qwen3-VL-30B, daytime)
LLM_EMBED_URL = os.environ.get("LLM_EMBED_URL", "http://localhost:8083")  # Embedding model (nomic-embed-text, always on)
EMBED_MODEL = os.environ.get("EMBED_MODEL", "nomic-embed-text")
EXTRACT_MODEL = os.environ.get("EXTRACT_MODEL", "qwen3.5:35b")        # Legacy — extraction uses LLM_URL
EXTRACT_TEMPERATURE = float(os.environ.get("EXTRACT_TEMPERATURE", "0.1"))
VISION_MODEL = os.environ.get("VISION_MODEL", "qwen3.5:35b")          # Legacy — vision uses LLM_URL

WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "large-v3")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "auto")  # auto, cpu, cuda
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "float16")

DATA_DIR = os.environ.get("DATA_DIR", os.path.expanduser("~/clawdbot-memory"))
MEMORIES_FILE = os.path.join(DATA_DIR, "memories.json")
ARCHIVE_FILE = os.path.join(DATA_DIR, "memories_archive.json")
PROCESSED_DIR = os.path.join(DATA_DIR, "processed")

PORT = int(os.environ.get("MEMORY_SERVICE_PORT", "5100"))

CATEGORIES = [
    "preference", "person", "legal", "travel", "accommodation",
    "henry", "ai_consultancy", "schedule", "general",
    "identity", "dream", "system", "insight",
    "document", "document_chunk", "document_index",
]

# Default TTL in days per category (0 = permanent)
DEFAULT_TTL = {
    "preference": 0,
    "person": 0,
    "legal": 0,
    "travel": 14,
    "accommodation": 90,
    "henry": 30,
    "ai_consultancy": 0,
    "schedule": 7,
    "general": 90,
    "identity": 0,
    "dream": 0,
    "system": 7,
    "insight": 0,
    "document": 0,
    "document_chunk": 90,
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
