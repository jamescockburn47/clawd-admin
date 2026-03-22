"""LLM client for memory service — uses llama.cpp servers.

Embeddings: dedicated nomic-embed-text server on port 8083 (always on)
Extraction: main Qwen3-30B server on port 8080 (daytime only)
"""

import json
import logging

import httpx

import config

logger = logging.getLogger("llm-client")

EMBED_URL = config.LLM_EMBED_URL if hasattr(config, 'LLM_EMBED_URL') else "http://localhost:8083"


async def embed(texts: list[str]) -> list[list[float]]:
    """Embed texts using dedicated llama.cpp embedding server."""
    results = []
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            for text in texts:
                resp = await client.post(
                    f"{EMBED_URL}/v1/embeddings",
                    json={"input": text, "model": "nomic"},
                )
                resp.raise_for_status()
                data = resp.json()
                results.append(data["data"][0]["embedding"])
    except Exception as e:
        logger.warning(f"Embedding failed: {e} — returning empty for remaining")
        # Pad with empty embeddings for any remaining texts
        while len(results) < len(texts):
            results.append([])
    return results


async def embed_single(text: str) -> list[float]:
    """Embed a single text."""
    result = await embed([text])
    return result[0] if result else []


async def extract_facts(conversation: str, today: str) -> list[dict]:
    """Extract facts using llama.cpp main model (OpenAI-compatible API)."""
    prompt = config.EXTRACTION_PROMPT.format(today=today)

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{config.LLM_URL}/v1/chat/completions",
                json={
                    "messages": [
                        {"role": "system", "content": "You extract structured facts from conversations. Output only JSON."},
                        {"role": "user", "content": f"{prompt}\n\nConversation:\n{conversation}"},
                    ],
                    "temperature": 0.1,
                    "max_tokens": 1000,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            response_text = data["choices"][0]["message"]["content"].strip()

        # Parse JSON from response (handle markdown fences)
        if response_text.startswith("```"):
            lines = response_text.split("\n")
            response_text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

        facts = json.loads(response_text)
        if isinstance(facts, list):
            return facts
    except Exception as e:
        logger.warning(f"Fact extraction failed: {e}")

    return []


async def analyse_image(image_bytes: bytes, prompt: str = "Describe this image.") -> str:
    """Image analysis — not available via llama.cpp currently."""
    return ""


async def check_ollama() -> dict:
    """Check llama.cpp server health (function name kept for API compat)."""
    status = {}
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # Check embedding server (always on)
            resp = await client.get(f"{EMBED_URL}/health")
            status["embedding"] = "online" if resp.status_code == 200 else "offline"
    except Exception:
        status["embedding"] = "offline"

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # Check main LLM (daytime only)
            resp = await client.get(f"{config.LLM_URL}/health")
            status["llm"] = "online" if resp.status_code == 200 else "offline"
    except Exception:
        status["llm"] = "offline"

    overall = "online" if status.get("embedding") == "online" else "degraded"
    return {"status": overall, "backend": "llama.cpp", **status}
