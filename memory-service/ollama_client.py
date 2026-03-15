"""Ollama API client for embeddings, extraction, and vision."""

import json
import base64

import httpx

import config


async def embed(texts: list[str]) -> list[list[float]]:
    """Embed one or more texts using Ollama."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        results = []
        for text in texts:
            resp = await client.post(
                f"{config.OLLAMA_HOST}/api/embed",
                json={"model": config.EMBED_MODEL, "input": text},
            )
            resp.raise_for_status()
            data = resp.json()
            results.append(data["embeddings"][0])
        return results


async def embed_single(text: str) -> list[float]:
    """Embed a single text."""
    result = await embed([text])
    return result[0]


async def extract_facts(conversation: str, today: str) -> list[dict]:
    """Extract facts from a conversation using the extraction model."""
    prompt = config.EXTRACTION_PROMPT.format(today=today)
    full_prompt = f"{prompt}\n\nConversation:\n{conversation}"

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{config.OLLAMA_HOST}/api/generate",
            json={
                "model": config.EXTRACT_MODEL,
                "prompt": full_prompt,
                "stream": False,
                "options": {"temperature": config.EXTRACT_TEMPERATURE},
                "think": False,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        response_text = data.get("response", "")

    # Parse JSON from response (handle markdown fences)
    response_text = response_text.strip()
    if response_text.startswith("```"):
        lines = response_text.split("\n")
        response_text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    try:
        facts = json.loads(response_text)
        if isinstance(facts, list):
            return facts
    except json.JSONDecodeError:
        pass

    return []


async def analyse_image(image_bytes: bytes, prompt: str = "Describe this image in detail. Extract any text, numbers, names, dates, or other factual information visible.") -> str:
    """Analyse an image using the vision model."""
    b64 = base64.b64encode(image_bytes).decode("utf-8")

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{config.OLLAMA_HOST}/api/generate",
            json={
                "model": config.VISION_MODEL,
                "prompt": prompt,
                "images": [b64],
                "stream": False,
                "options": {"temperature": 0.1},
                "think": False,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("response", "")


async def check_ollama() -> dict:
    """Check Ollama health and loaded models."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{config.OLLAMA_HOST}/api/tags")
            resp.raise_for_status()
            data = resp.json()
            models = [m["name"] for m in data.get("models", [])]
            return {"status": "online", "models": models}
    except Exception as e:
        return {"status": "offline", "error": str(e), "models": []}
