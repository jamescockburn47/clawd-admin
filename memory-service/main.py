"""Clawd Memory Service — FastAPI application."""

import logging
import time
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

import config
import llm_client
import whisper_service
from command_router import route_voice_command_async
from memory_store import MemoryStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("memory-service")

app = FastAPI(title="Clawd Memory Service", version="1.0.0")
store = MemoryStore()

# Track service start time
_start_time = time.time()


# --- Request/Response models ---

class StoreRequest(BaseModel):
    fact: str
    category: str = "general"
    tags: list[str] = []
    confidence: float = 0.9
    source: str = "api"
    supersedes: Optional[str] = None
    expires: Optional[str] = None


class SearchRequest(BaseModel):
    query: str
    category: Optional[str] = None
    limit: int = 8
    search_archive: bool = False


class UpdateRequest(BaseModel):
    fact: Optional[str] = None
    category: Optional[str] = None
    tags: Optional[list[str]] = None
    confidence: Optional[float] = None
    status: Optional[str] = None


class ConsolidateClusterRequest(BaseModel):
    merged_fact: str
    merged_tags: list[str] = []
    merged_confidence: float = 0.9
    source_ids: list[str]


class ExtractRequest(BaseModel):
    conversation: str
    store_results: bool = True
    source: str = "conversation"


class NoteRequest(BaseModel):
    text: str
    source: str = "manual_note"


class RouteCommandRequest(BaseModel):
    text: str


# --- Health ---

@app.get("/health")
async def health():
    llm_status = await llm_client.check_health()
    uptime = int(time.time() - _start_time)
    return {
        "status": "online",
        "uptime_seconds": uptime,
        "llm": llm_status,
        "whisper": {
            "available": whisper_service.is_available(),
            "loaded": whisper_service.is_loaded(),
            "model": config.WHISPER_MODEL_SIZE,
        },
        "memory": store.stats(),
    }


# --- Memory CRUD ---

@app.post("/memory/store")
async def memory_store(req: StoreRequest):
    embedding = await llm_client.embed_single(req.fact)
    result = store.store(
        fact=req.fact,
        category=req.category,
        tags=req.tags,
        embedding=embedding,
        confidence=req.confidence,
        source=req.source,
        supersedes=req.supersedes,
        expires=req.expires,
    )
    # Pre-store dedup may return a duplicate marker instead of a record
    if isinstance(result, dict) and result.get("duplicate"):
        logger.info(f"Pre-store dedup: skipped (sim={result['similarity']}, matched={result['matchedId']})")
        return {"stored": False, "duplicate": True, **result}
    return {"stored": True, "memory": {k: v for k, v in result.items() if k != "embedding"}}


@app.post("/memory/search")
async def memory_search(req: SearchRequest):
    query_embedding = await llm_client.embed_single(req.query, is_query=True)
    results = store.search(
        query_embedding=query_embedding,
        query_text=req.query,
        category=req.category,
        limit=req.limit,
        search_archive=req.search_archive,
    )
    # Strip embeddings from response
    for r in results:
        r["memory"] = {k: v for k, v in r["memory"].items() if k != "embedding"}
    return {"results": results, "count": len(results)}


@app.get("/memory/list")
async def memory_list(include_embeddings: bool = False, include_archived: bool = False):
    memories = store.list_all(include_embeddings=include_embeddings, include_archived=include_archived)
    return {"memories": memories, "count": len(memories)}


@app.put("/memory/{memory_id}")
async def memory_update(memory_id: str, req: UpdateRequest):
    embedding = None
    if req.fact is not None:
        embedding = await llm_client.embed_single(req.fact)

    updated = store.update(
        memory_id=memory_id,
        fact=req.fact,
        category=req.category,
        tags=req.tags,
        confidence=req.confidence,
        embedding=embedding,
        status=req.status,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Memory not found")
    return {"updated": True, "memory": {k: v for k, v in updated.items() if k != "embedding"}}


@app.delete("/memory/{memory_id}")
async def memory_delete(memory_id: str):
    """Soft-archive a memory. Nothing is ever hard-deleted."""
    archived = store.delete(memory_id)
    if not archived:
        raise HTTPException(status_code=404, detail="Memory not found")
    return {"archived": True, "note": "memory soft-archived, not hard-deleted"}


@app.post("/memory/{memory_id}/archive")
async def memory_archive(memory_id: str):
    """Explicitly soft-archive a memory by ID."""
    archived = store.archive_memory(memory_id)
    if not archived:
        raise HTTPException(status_code=404, detail="Memory not found")
    return {"archived": True}


@app.post("/memory/consolidate")
async def memory_consolidate(req: ConsolidateClusterRequest):
    """Store a consolidated (LLM-merged) fact and supersede the source memories."""
    embedding = await llm_client.embed_single(req.merged_fact)
    record = store.consolidate_cluster(
        merged_fact=req.merged_fact,
        merged_tags=req.merged_tags,
        merged_confidence=req.merged_confidence,
        source_ids=req.source_ids,
        embedding=embedding,
    )
    return {"stored": True, "memory": {k: v for k, v in record.items() if k != "embedding"},
            "superseded_count": len(req.source_ids)}


@app.get("/memory/consolidation-candidates")
async def consolidation_candidates(min_sim: float = 0.55, max_sim: float = 0.70,
                                   max_clusters: int = 20):
    """Return clusters of related-but-distinct active memories for consolidation review."""
    clusters = store.get_consolidation_candidates(min_sim=min_sim, max_sim=max_sim,
                                                   max_clusters=max_clusters)
    result = []
    for cluster in clusters:
        result.append({
            "memories": [{k: v for k, v in m.items() if k != "embedding"} for m in cluster],
            "count": len(cluster),
        })
    return {"clusters": result, "cluster_count": len(result)}


@app.get("/memory/stats")
async def memory_stats():
    return store.stats()


# --- Embedding ---

@app.post("/embed")
async def embed_text(texts: list[str]):
    embeddings = await llm_client.embed(texts)
    return {"embeddings": embeddings, "count": len(embeddings), "dimensions": len(embeddings[0]) if embeddings else 0}


# --- Extraction ---

@app.post("/extract")
async def extract_facts(req: ExtractRequest):
    today = datetime.utcnow().strftime("%Y-%m-%d")
    facts = await llm_client.extract_facts(req.conversation, today)

    stored = []
    skipped = 0
    if req.store_results and facts:
        for fact_data in facts:
            if not isinstance(fact_data, dict) or "fact" not in fact_data:
                continue
            try:
                embedding = await llm_client.embed_single(fact_data["fact"])
                result = store.store(
                    fact=fact_data["fact"],
                    category=fact_data.get("category", "general"),
                    tags=fact_data.get("tags", []),
                    embedding=embedding,
                    confidence=fact_data.get("confidence", 0.8),
                    source=req.source,
                )
                if isinstance(result, dict) and result.get("duplicate"):
                    skipped += 1
                else:
                    stored.append({k: v for k, v in result.items() if k != "embedding"})
            except Exception as e:
                logger.error(f"Failed to store extracted fact: {e}")

    return {
        "extracted": facts,
        "stored": stored,
        "count": len(facts),
        "stored_count": len(stored),
        "skipped_duplicates": skipped,
    }


# --- Note (direct storage, minimal processing) ---

@app.post("/note")
async def store_note(req: NoteRequest):
    """Store a direct note — extract facts from it and store them."""
    today = datetime.utcnow().strftime("%Y-%m-%d")
    facts = await llm_client.extract_facts(req.text, today)

    if not facts:
        # If extraction fails, store the raw text as a single memory
        embedding = await llm_client.embed_single(req.text)
        record = store.store(
            fact=req.text[:300],
            category="general",
            tags=[],
            embedding=embedding,
            confidence=0.95,
            source=req.source,
        )
        return {"stored": [{k: v for k, v in record.items() if k != "embedding"}], "count": 1}

    stored = []
    for fact_data in facts:
        if not isinstance(fact_data, dict) or "fact" not in fact_data:
            continue
        try:
            embedding = await llm_client.embed_single(fact_data["fact"])
            record = store.store(
                fact=fact_data["fact"],
                category=fact_data.get("category", "general"),
                tags=fact_data.get("tags", []),
                embedding=embedding,
                confidence=fact_data.get("confidence", 0.95),
                source=req.source,
            )
            stored.append({k: v for k, v in record.items() if k != "embedding"})
        except Exception as e:
            logger.error(f"Failed to store note fact: {e}")

    return {"stored": stored, "count": len(stored)}


# --- Transcription ---

@app.post("/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    language: str = Form("en"),
    extract: bool = Form(False),
    store_results: bool = Form(False),
):
    """Transcribe audio and optionally extract/store facts."""
    if not whisper_service.is_available():
        raise HTTPException(status_code=503, detail="Whisper not available")

    audio_bytes = await file.read()
    result = whisper_service.transcribe(audio_bytes, language=language)

    response = {"transcription": result}

    if extract and result["text"]:
        today = datetime.utcnow().strftime("%Y-%m-%d")
        facts = await llm_client.extract_facts(result["text"], today)
        response["extracted"] = facts

        if store_results and facts:
            stored = []
            for fact_data in facts:
                if not isinstance(fact_data, dict) or "fact" not in fact_data:
                    continue
                try:
                    embedding = await llm_client.embed_single(fact_data["fact"])
                    record = store.store(
                        fact=fact_data["fact"],
                        category=fact_data.get("category", "general"),
                        tags=fact_data.get("tags", []),
                        embedding=embedding,
                        confidence=fact_data.get("confidence", 0.8),
                        source="voice_note",
                    )
                    stored.append({k: v for k, v in record.items() if k != "embedding"})
                except Exception as e:
                    logger.error(f"Failed to store voice fact: {e}")
            response["stored"] = stored

    return response


# --- Image Analysis ---

@app.post("/analyse-image")
async def analyse_image(
    file: UploadFile = File(...),
    prompt: str = Form("Describe this image in detail. Extract any text, numbers, names, dates, or other factual information visible."),
    extract: bool = Form(False),
    store_results: bool = Form(False),
):
    """Analyse an image and optionally extract/store facts."""
    image_bytes = await file.read()
    description = await llm_client.analyse_image(image_bytes, prompt)

    response = {"description": description}

    if extract and description:
        today = datetime.utcnow().strftime("%Y-%m-%d")
        facts = await llm_client.extract_facts(description, today)
        response["extracted"] = facts

        if store_results and facts:
            stored = []
            for fact_data in facts:
                if not isinstance(fact_data, dict) or "fact" not in fact_data:
                    continue
                try:
                    embedding = await llm_client.embed_single(fact_data["fact"])
                    record = store.store(
                        fact=fact_data["fact"],
                        category=fact_data.get("category", "general"),
                        tags=fact_data.get("tags", []),
                        embedding=embedding,
                        confidence=fact_data.get("confidence", 0.7),
                        source="image_analysis",
                    )
                    stored.append({k: v for k, v in record.items() if k != "embedding"})
                except Exception as e:
                    logger.error(f"Failed to store image fact: {e}")
            response["stored"] = stored

    return response


# --- Maintenance ---

@app.post("/maintain")
async def maintain():
    """Run maintenance: soft-archive expired memories, deduplicate."""
    archived_count = store.archive_expired()
    dedup_count = store.deduplicate()
    stats = store.stats()
    return {
        "archived": archived_count,
        "deduplicated": dedup_count,
        "total_after": stats["total"],
        "active_after": stats["active"],
    }


# --- Re-embed all memories (for embedding model migration) ---

@app.post("/reembed")
async def reembed_all():
    """Re-embed all memories with the current embedding model. Used after model upgrades."""
    total = len(store.memories)
    success = 0
    failed = 0
    batch_size = 10

    for start in range(0, total, batch_size):
        batch = store.memories[start:start + batch_size]
        texts = [m["fact"] for m in batch]
        try:
            embeddings = await llm_client.embed(texts, is_query=False)
            for m, emb in zip(batch, embeddings):
                if emb:
                    m["embedding"] = emb
                    success += 1
                else:
                    failed += 1
        except Exception as e:
            logger.error(f"Re-embed batch failed at {start}: {e}")
            failed += len(batch)

    if success > 0:
        store._save()
        store._build_index()

    return {
        "total": total,
        "reembedded": success,
        "failed": failed,
        "embedding_dim": len(store.memories[0]["embedding"]) if store.memories and store.memories[0].get("embedding") else 0,
    }


# --- Voice command routing (EVO wake listener → Pi /api/voice-local) ---


@app.post("/route-command")
async def route_command(req: RouteCommandRequest):
    """Classify transcribed voice text into a fast local action or Claude."""
    t0 = time.perf_counter()
    out = await route_voice_command_async(req.text)
    result = dict(out)
    result["latency_ms"] = int((time.perf_counter() - t0) * 1000)
    return result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=config.PORT)
