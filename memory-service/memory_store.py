"""Memory storage and retrieval with hybrid search.

Frontal lobe: source-weighted scoring, confidence decay for volatile categories,
contradiction suppression at retrieval, and auto-supersession at store time.
"""

import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timedelta

import numpy as np

import config

logger = logging.getLogger("memory-service")

# Categories that are never expired, deduplicated, or superseded
PROTECTED_CATEGORIES = {"identity"}

# Cosine similarity threshold for pre-store and batch deduplication
DEDUP_THRESHOLD = 0.92

# --- Frontal lobe: source weights ---
# Authoritative sources score higher. Multiplicative on combined score.
SOURCE_WEIGHTS = {
    "system_knowledge": 1.25,
    "system_knowledge_seed": 1.25,
    "manual_note": 1.15,
    "conversation": 1.0,
    "voice_note": 1.0,
    "diary_extraction": 0.95,
    "diary_insight": 0.95,
    "dream_mode": 0.90,
    "project_thinker": 0.95,
    "image_analysis": 0.90,
    "api": 1.0,
}

# --- Frontal lobe: confidence decay ---
# Only volatile categories decay. Stable facts (identity, preference, legal, etc.) never decay.
# Half-life in days: confidence halves every N days for these categories.
VOLATILE_CATEGORIES = {
    "system": 30,
    "schedule": 7,
    "travel": 14,
    "accommodation": 60,
    "henry": 30,
    "dream": 45,
    "document_chunk": 60,
}

# Sources that produce ephemeral/inferred facts (used for "general" category decay)
EPHEMERAL_SOURCES = {"diary_extraction", "diary_insight", "dream_mode", "image_analysis"}

# General memories from ephemeral sources decay at this half-life
GENERAL_EPHEMERAL_HALF_LIFE = 60

# --- Frontal lobe: contradiction suppression ---
CONTRADICTION_THRESHOLD = 0.75

# --- Frontal lobe: auto-supersession ---
SUPERSESSION_THRESHOLD_LOW = 0.70
SUPERSESSION_THRESHOLD_HIGH = 0.91


def _load_json(path):
    if not os.path.exists(path):
        return []
    with open(path, "r") as f:
        return json.load(f)


def _save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def _effective_confidence(confidence, category, source, days_old):
    """Compute confidence with decay for volatile categories. Stable categories return stored confidence."""
    half_life = VOLATILE_CATEGORIES.get(category)

    # General memories: decay only if from an ephemeral source
    if category == "general" and source in EPHEMERAL_SOURCES:
        half_life = GENERAL_EPHEMERAL_HALF_LIFE
    elif category == "general":
        half_life = None  # Explicit general facts are stable

    if half_life and days_old > 0:
        return confidence * (0.5 ** (days_old / half_life))
    return confidence


class MemoryStore:
    def __init__(self):
        os.makedirs(config.DATA_DIR, exist_ok=True)
        os.makedirs(config.PROCESSED_DIR, exist_ok=True)
        self.memories = _load_json(config.MEMORIES_FILE)
        self._embeddings_matrix = None
        self._build_index()

    def _build_index(self):
        """Build numpy matrix of embeddings for fast cosine similarity."""
        vecs = []
        for m in self.memories:
            emb = m.get("embedding")
            if emb and len(emb) > 0:
                vecs.append(emb)
            else:
                vecs.append(None)
        if any(v is not None for v in vecs):
            dim = len(next(v for v in vecs if v is not None))
            mat = []
            for v in vecs:
                mat.append(v if v is not None else [0.0] * dim)
            self._embeddings_matrix = np.array(mat, dtype=np.float32)
            norms = np.linalg.norm(self._embeddings_matrix, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            self._embeddings_matrix = self._embeddings_matrix / norms
        else:
            self._embeddings_matrix = None

    def _save(self):
        _save_json(config.MEMORIES_FILE, self.memories)

    def _check_supersession(self, embedding, category, source):
        """Find an existing same-category memory that the new one should supersede.

        Looks for memories in the 0.70-0.91 cosine similarity range (same topic,
        different content). Below dedup threshold but clearly related.
        Protected categories and older-than-existing facts are exempt.
        """
        if (not embedding or category in PROTECTED_CATEGORIES
                or self._embeddings_matrix is None or len(self.memories) == 0):
            return None

        qvec = np.array(embedding, dtype=np.float32)
        qnorm = np.linalg.norm(qvec)
        if qnorm <= 0:
            return None

        qvec = qvec / qnorm
        similarities = self._embeddings_matrix @ qvec

        best_idx = int(np.argmax(similarities))
        best_sim = float(similarities[best_idx])

        if SUPERSESSION_THRESHOLD_LOW <= best_sim < SUPERSESSION_THRESHOLD_HIGH:
            candidate = self.memories[best_idx]
            # Only supersede within same category
            if candidate["category"] != category:
                return None
            # Only supersede if new memory is newer
            try:
                old_date = datetime.strptime(candidate["sourceDate"], "%Y-%m-%d")
                if datetime.utcnow() < old_date:
                    return None
            except (ValueError, KeyError):
                pass
            return candidate["id"]

        return None

    def store(self, fact, category, tags, embedding=None, confidence=0.9,
              source="unknown", supersedes=None, expires=None):
        """Store a new memory. Returns the record, or a duplicate marker if skipped."""
        # Pre-store dedup: skip if a near-identical memory already exists
        safe_category = category if category in config.CATEGORIES else "general"
        if (embedding and safe_category not in PROTECTED_CATEGORIES
                and self._embeddings_matrix is not None and len(self.memories) > 0):
            qvec = np.array(embedding, dtype=np.float32)
            qnorm = np.linalg.norm(qvec)
            if qnorm > 0:
                qvec = qvec / qnorm
                similarities = self._embeddings_matrix @ qvec
                best_idx = int(np.argmax(similarities))
                best_sim = float(similarities[best_idx])
                if best_sim >= DEDUP_THRESHOLD:
                    existing = self.memories[best_idx]
                    return {
                        "duplicate": True,
                        "skipped": True,
                        "matchedId": existing["id"],
                        "matchedFact": existing["fact"],
                        "similarity": round(best_sim, 4),
                    }

        # Auto-supersession: if caller didn't specify, check for same-topic older memory
        if not supersedes:
            auto_target = self._check_supersession(embedding, safe_category, source)
            if auto_target:
                supersedes = auto_target
                logger.info(f"Auto-supersession: new fact supersedes {auto_target}")

        mem_id = f"mem_{uuid.uuid4().hex[:8]}"
        now = datetime.utcnow().isoformat() + "Z"

        if expires is None and config.DEFAULT_TTL.get(category, 0) > 0:
            ttl_days = config.DEFAULT_TTL[category]
            expires = (datetime.utcnow() + timedelta(days=ttl_days)).strftime("%Y-%m-%d")

        record = {
            "id": mem_id,
            "fact": fact[:300],
            "category": category if category in config.CATEGORIES else "general",
            "tags": [t.lower().strip() for t in tags],
            "source": source,
            "sourceDate": datetime.utcnow().strftime("%Y-%m-%d"),
            "confidence": min(1.0, max(0.0, confidence)),
            "supersedes": supersedes,
            "expires": expires,
            "lastAccessed": now,
            "accessCount": 0,
            "embedding": embedding or [],
        }

        if supersedes:
            for m in self.memories:
                if m["id"] == supersedes:
                    self._archive_memory(m, reason="superseded", superseded_by=mem_id)
                    self.memories.remove(m)
                    break

        self.memories.append(record)
        self._save()
        self._build_index()
        return record

    def _suppress_contradictions(self, results):
        """Remove lower-ranked memories that cover the same topic as higher-ranked ones.

        Results are already sorted by score (best first). For each candidate, check if
        it's semantically very similar (>= 0.75 cosine) to an already-accepted memory.
        If so, the lower-scoring version is suppressed — the higher one already covers
        that topic with more authority.
        """
        if len(results) < 2:
            return results

        kept = []
        kept_vecs = []

        for score, mem in results:
            emb = mem.get("embedding")
            if not emb:
                kept.append((score, mem))
                continue

            mvec = np.array(emb, dtype=np.float32)
            mnorm = np.linalg.norm(mvec)
            if mnorm <= 0:
                kept.append((score, mem))
                continue
            mvec = mvec / mnorm

            # Check against all already-kept memories
            dominated = False
            for kvec in kept_vecs:
                sim = float(np.dot(mvec, kvec))
                if sim >= CONTRADICTION_THRESHOLD:
                    dominated = True
                    break

            if not dominated:
                kept.append((score, mem))
                kept_vecs.append(mvec)

        return kept

    def search(self, query_embedding=None, query_text="", category=None, limit=8):
        """Hybrid search: keyword + vector + recency + effective_confidence.

        Scoring formula:
            base = 0.30 * keyword + 0.40 * vector + 0.10 * recency + 0.20 * eff_confidence
            combined = base * source_weight

        Then contradiction suppression removes lower-scored entries that cover the
        same topic as a higher-scored entry (cosine >= 0.75).
        """
        now = datetime.utcnow()
        results = []

        query_tokens = set(re.findall(r'\w+', query_text.lower())) if query_text else set()

        for i, m in enumerate(self.memories):
            # Skip expired
            if m.get("expires"):
                try:
                    exp = datetime.strptime(m["expires"], "%Y-%m-%d")
                    if exp < now:
                        continue
                except ValueError:
                    pass

            if category and m["category"] != category:
                continue

            # Keyword score
            keyword_score = 0.0
            if query_tokens:
                tag_set = set(m.get("tags", []))
                fact_tokens = set(re.findall(r'\w+', m["fact"].lower()))
                matched = query_tokens & (tag_set | fact_tokens)
                keyword_score = len(matched) / max(len(query_tokens), 1)

            # Vector score
            vector_score = 0.0
            if (query_embedding is not None and
                    self._embeddings_matrix is not None and
                    i < len(self._embeddings_matrix)):
                qvec = np.array(query_embedding, dtype=np.float32)
                qnorm = np.linalg.norm(qvec)
                if qnorm > 0:
                    qvec = qvec / qnorm
                    vector_score = float(np.dot(self._embeddings_matrix[i], qvec))
                    vector_score = max(0.0, vector_score)

            # Recency score
            try:
                created = datetime.strptime(m["sourceDate"], "%Y-%m-%d")
                days_old = (now - created).days
                recency_score = max(0.0, 1.0 - days_old / 90)
            except (ValueError, KeyError):
                days_old = 0
                recency_score = 0.5

            # Effective confidence (decays for volatile categories only)
            eff_conf = _effective_confidence(
                m.get("confidence", 0.5),
                m["category"],
                m.get("source", "unknown"),
                days_old,
            )

            # Combined score with source weight
            base = (0.30 * keyword_score +
                    0.40 * vector_score +
                    0.10 * recency_score +
                    0.20 * eff_conf)

            source_weight = SOURCE_WEIGHTS.get(m.get("source", "unknown"), 1.0)
            combined = base * source_weight

            results.append((combined, m))

        results.sort(key=lambda x: x[0], reverse=True)

        # Overshoot: fetch extra candidates to compensate for contradiction suppression
        overshoot_limit = min(len(results), int(limit * 1.5) + 1)
        candidates = results[:overshoot_limit]

        # Contradiction suppression: drop lower-scored entries on the same topic
        candidates = self._suppress_contradictions(candidates)

        top = candidates[:limit]

        # Update access counts
        for _, m in top:
            m["accessCount"] = m.get("accessCount", 0) + 1
            m["lastAccessed"] = now.isoformat() + "Z"
        if top:
            self._save()

        return [{"score": s, "memory": m} for s, m in top]

    def update(self, memory_id, fact=None, category=None, tags=None,
               confidence=None, embedding=None):
        """Update an existing memory."""
        for m in self.memories:
            if m["id"] == memory_id:
                if fact is not None:
                    m["fact"] = fact[:300]
                if category is not None and category in config.CATEGORIES:
                    m["category"] = category
                if tags is not None:
                    m["tags"] = [t.lower().strip() for t in tags]
                if confidence is not None:
                    m["confidence"] = min(1.0, max(0.0, confidence))
                if embedding is not None:
                    m["embedding"] = embedding
                self._save()
                self._build_index()
                return m
        return None

    def delete(self, memory_id):
        """Delete a memory (archive it)."""
        for m in self.memories:
            if m["id"] == memory_id:
                self._archive_memory(m, reason="deleted")
                self.memories.remove(m)
                self._save()
                self._build_index()
                return True
        return False

    def list_all(self, include_embeddings=False):
        """List all memories, optionally without embeddings (for cache sync)."""
        if include_embeddings:
            return self.memories
        return [{k: v for k, v in m.items() if k != "embedding"} for m in self.memories]

    def stats(self):
        """Return memory statistics."""
        cats = {}
        for m in self.memories:
            c = m.get("category", "general")
            cats[c] = cats.get(c, 0) + 1
        return {
            "total": len(self.memories),
            "categories": cats,
            "oldest": min((m["sourceDate"] for m in self.memories), default=None),
            "newest": max((m["sourceDate"] for m in self.memories), default=None),
        }

    def deduplicate(self, similarity_threshold=DEDUP_THRESHOLD):
        """Find and merge duplicate memories based on vector similarity."""
        if self._embeddings_matrix is None or len(self.memories) < 2:
            return 0

        removed = 0
        to_remove = set()
        n = len(self.memories)

        for i in range(n):
            if i in to_remove:
                continue
            for j in range(i + 1, n):
                if j in to_remove:
                    continue
                sim = float(np.dot(self._embeddings_matrix[i], self._embeddings_matrix[j]))
                if sim >= similarity_threshold:
                    # Keep the newer or higher-confidence one
                    mi, mj = self.memories[i], self.memories[j]
                    if mi.get("confidence", 0) >= mj.get("confidence", 0):
                        to_remove.add(j)
                    else:
                        to_remove.add(i)
                    removed += 1

        if to_remove:
            for idx in sorted(to_remove, reverse=True):
                self._archive_memory(self.memories[idx], reason="deduplicated")
                self.memories.pop(idx)
            self._save()
            self._build_index()

        return removed

    def expire_old(self):
        """Remove expired memories."""
        now = datetime.utcnow()
        expired = []
        for m in self.memories:
            if m.get("expires"):
                try:
                    exp = datetime.strptime(m["expires"], "%Y-%m-%d")
                    if exp < now:
                        expired.append(m)
                except ValueError:
                    pass

        for m in expired:
            self._archive_memory(m, reason="expired")
            self.memories.remove(m)

        if expired:
            self._save()
            self._build_index()

        return len(expired)

    def _archive_memory(self, memory, reason="unknown", superseded_by=None):
        """Move a memory to the archive."""
        archive = _load_json(config.ARCHIVE_FILE)
        record = {**memory, "archivedAt": datetime.utcnow().isoformat() + "Z",
                  "archiveReason": reason}
        if superseded_by:
            record["supersededBy"] = superseded_by
        # Don't archive embeddings (save space)
        record.pop("embedding", None)
        archive.append(record)
        _save_json(config.ARCHIVE_FILE, archive)
