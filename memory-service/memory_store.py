"""Memory storage and retrieval with hybrid search."""

import json
import os
import re
import time
import uuid
from datetime import datetime, timedelta

import numpy as np

import config


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

    def store(self, fact, category, tags, embedding=None, confidence=0.9,
              source="unknown", supersedes=None, expires=None):
        """Store a new memory."""
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

    def search(self, query_embedding=None, query_text="", category=None, limit=8):
        """Hybrid search: keyword + vector + recency + frequency."""
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
                recency_score = 0.5

            # Frequency score
            freq_score = min(1.0, m.get("accessCount", 0) / 10)

            combined = (0.35 * keyword_score +
                        0.40 * vector_score +
                        0.15 * recency_score +
                        0.10 * freq_score)

            results.append((combined, m))

        results.sort(key=lambda x: x[0], reverse=True)
        top = results[:limit]

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

    def deduplicate(self, similarity_threshold=0.85):
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
