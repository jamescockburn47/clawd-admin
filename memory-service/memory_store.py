"""Memory storage and retrieval with hybrid search.

Frontal lobe: source-weighted scoring, confidence decay for volatile categories,
contradiction suppression at retrieval, and auto-supersession at store time.

Retrieval: BM25 + vector with Reciprocal Rank Fusion (RRF), plus recency
and effective confidence signals.
"""

import json
import logging
import math
import os
import re
import time
import uuid
from collections import Counter
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
    "system": 7,       # matches DEFAULT_TTL["system"]=7; reseeded nightly so 30d half-life was unreachable
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
# 0.83 avoids suppressing related-but-distinct short facts while still
# catching genuine contradictions (which embed at 0.88+ due to shared words).
CONTRADICTION_THRESHOLD = 0.83

# --- Frontal lobe: auto-supersession ---
SUPERSESSION_THRESHOLD_LOW = 0.70
SUPERSESSION_THRESHOLD_HIGH = 0.91

# --- BM25 parameters ---
BM25_K1 = 1.2   # Term frequency saturation
BM25_B = 0.75   # Length normalisation strength

# --- RRF fusion ---
RRF_K = 60  # Reciprocal Rank Fusion constant (standard value)

# Stop words excluded from BM25 tokenisation
_STOP_WORDS = frozenset({
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "out", "off", "over",
    "under", "again", "further", "then", "once", "here", "there", "when",
    "where", "why", "how", "all", "each", "every", "both", "few", "more",
    "most", "other", "some", "such", "no", "nor", "not", "only", "own",
    "same", "so", "than", "too", "very", "just", "and", "but", "or", "if",
    "that", "this", "it", "its", "i", "me", "my", "we", "our", "you",
    "your", "he", "him", "his", "she", "her", "they", "them", "their",
    "what", "which", "who", "whom",
})


def _tokenise(text):
    """Tokenise text for BM25: lowercase, alphanumeric, stop words removed."""
    return [t for t in re.findall(r'\w+', text.lower()) if t not in _STOP_WORDS and len(t) > 1]


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
        self._doc_tokens = []     # BM25: tokenised docs
        self._doc_lengths = []    # BM25: doc lengths
        self._avg_dl = 0.0       # BM25: average doc length
        self._idf_cache = {}     # BM25: IDF per term
        self._build_index()

    def _build_index(self):
        """Build vector index (numpy) and BM25 index (IDF + doc tokens)."""
        # --- Vector index ---
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

        # --- BM25 index ---
        self._doc_tokens = []
        self._doc_lengths = []
        df = Counter()  # Document frequency per term
        for m in self.memories:
            # Tokenise fact + tags together (tags go through _tokenise too so
            # compound tags like "ai_consultancy" split into ["ai", "consultancy"])
            tag_tokens = []
            for t in m.get("tags", []):
                tag_tokens.extend(_tokenise(t))
            tokens = _tokenise(m["fact"]) + tag_tokens
            self._doc_tokens.append(tokens)
            self._doc_lengths.append(len(tokens))
            for term in set(tokens):
                df[term] += 1

        n = len(self.memories)
        self._avg_dl = sum(self._doc_lengths) / max(n, 1)
        # Precompute IDF: log((N - df + 0.5) / (df + 0.5) + 1)
        self._idf_cache = {}
        for term, freq in df.items():
            self._idf_cache[term] = math.log((n - freq + 0.5) / (freq + 0.5) + 1.0)

    def _bm25_score(self, query_tokens, doc_idx):
        """Compute BM25 score for a document given query tokens."""
        if doc_idx >= len(self._doc_tokens):
            return 0.0
        doc_toks = self._doc_tokens[doc_idx]
        dl = self._doc_lengths[doc_idx]
        if dl == 0:
            return 0.0

        tf_counter = Counter(doc_toks)
        score = 0.0
        for qt in query_tokens:
            idf = self._idf_cache.get(qt, 0.0)
            tf = tf_counter.get(qt, 0)
            numerator = tf * (BM25_K1 + 1)
            denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / max(self._avg_dl, 1))
            score += idf * numerator / denominator
        return score

    def _save(self):
        _save_json(config.MEMORIES_FILE, self.memories)

    def _check_supersession(self, embedding, category, source):
        """Find an existing same-category memory that the new one should supersede.

        Looks for memories in the 0.70-0.91 cosine similarity range (same topic,
        different content). Below dedup threshold but clearly related.
        Protected categories and older-than-existing facts are exempt.
        Only considers active memories — archived/superseded records are skipped.
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

        # Mask inactive memories so argmax only finds active candidates
        active_mask = np.array(
            [m.get("status", "active") == "active" for m in self.memories],
            dtype=bool,
        )
        masked = np.where(active_mask, similarities, -1.0)
        best_idx = int(np.argmax(masked))
        best_sim = float(masked[best_idx])

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
        # Pre-store dedup: skip if a near-identical ACTIVE memory already exists.
        # Archived/superseded memories are excluded from the match — a new fact should
        # be stored even if it closely matches an old archived one.
        safe_category = category if category in config.CATEGORIES else "general"
        if (embedding and safe_category not in PROTECTED_CATEGORIES
                and self._embeddings_matrix is not None and len(self.memories) > 0):
            qvec = np.array(embedding, dtype=np.float32)
            qnorm = np.linalg.norm(qvec)
            if qnorm > 0:
                qvec = qvec / qnorm
                similarities = self._embeddings_matrix @ qvec
                # Mask inactive memories so dedup only matches against active records
                active_mask = np.array(
                    [m.get("status", "active") == "active" for m in self.memories],
                    dtype=bool,
                )
                masked = np.where(active_mask, similarities, -1.0)
                best_idx = int(np.argmax(masked))
                best_sim = float(masked[best_idx])
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
            "status": "active",
            "supersedes": supersedes,
            "expires": expires,
            "lastAccessed": now,
            "accessCount": 0,
            "embedding": embedding or [],
        }

        if supersedes:
            now_iso = datetime.utcnow().isoformat() + "Z"
            for m in self.memories:
                if m["id"] == supersedes:
                    m["status"] = "superseded"
                    m["archivedAt"] = now_iso
                    m["archiveReason"] = "superseded"
                    m["supersededBy"] = mem_id
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

    def search(self, query_embedding=None, query_text="", category=None, limit=8,
               search_archive=False):
        """Hybrid search: BM25 + vector via RRF, boosted by recency, confidence, and source.

        Pipeline:
        1. Filter eligible memories (not archived/superseded, not expired, matching category)
        2. Score each via BM25 (lexical) and cosine similarity (vector)
        3. Rank separately, fuse via Reciprocal Rank Fusion (RRF)
        4. Apply recency, effective confidence, and source weight boosts
        5. Contradiction suppression on top results

        Pass search_archive=True to include archived/superseded memories (admin queries only).
        """
        now = datetime.utcnow()

        query_tokens = _tokenise(query_text) if query_text else []

        # Precompute normalised query vector once
        qvec = None
        if query_embedding is not None:
            qvec = np.array(query_embedding, dtype=np.float32)
            qnorm = np.linalg.norm(qvec)
            if qnorm > 0:
                qvec = qvec / qnorm
            else:
                qvec = None

        # --- Phase 1: Filter eligible and compute raw scores ---
        eligible = []  # (index, memory, bm25_score, vector_score, days_old)

        for i, m in enumerate(self.memories):
            # Skip non-active memories unless explicitly searching the archive
            if not search_archive and m.get("status", "active") != "active":
                continue

            if m.get("expires"):
                try:
                    exp = datetime.strptime(m["expires"], "%Y-%m-%d")
                    if exp < now:
                        continue
                except ValueError:
                    pass

            if category and m["category"] != category:
                continue

            # BM25 score
            bm25 = self._bm25_score(query_tokens, i) if query_tokens else 0.0

            # Vector score
            vec_score = 0.0
            if (qvec is not None and self._embeddings_matrix is not None
                    and i < len(self._embeddings_matrix)):
                vec_score = float(np.dot(self._embeddings_matrix[i], qvec))
                vec_score = max(0.0, vec_score)

            try:
                created = datetime.strptime(m["sourceDate"], "%Y-%m-%d")
                days_old = (now - created).days
            except (ValueError, KeyError):
                days_old = 0

            eligible.append((i, m, bm25, vec_score, days_old))

        if not eligible:
            return []

        # --- Phase 2: Rank separately, compute RRF ---
        # Sort by BM25 descending
        bm25_ranked = sorted(eligible, key=lambda x: x[2], reverse=True)
        bm25_rank = {item[0]: rank for rank, item in enumerate(bm25_ranked)}

        # Sort by vector descending
        vec_ranked = sorted(eligible, key=lambda x: x[3], reverse=True)
        vec_rank = {item[0]: rank for rank, item in enumerate(vec_ranked)}

        # --- Phase 3: Fuse and boost ---
        results = []
        for idx, m, bm25, vec_score, days_old in eligible:
            # RRF fusion: score = 1/(k + rank_bm25) + 1/(k + rank_vec)
            rrf = (1.0 / (RRF_K + bm25_rank[idx]) +
                   1.0 / (RRF_K + vec_rank[idx]))

            # Recency boost (0-1, linear decay over 90 days)
            recency = max(0.0, 1.0 - days_old / 90)

            # Effective confidence (decays for volatile categories only)
            eff_conf = _effective_confidence(
                m.get("confidence", 0.5),
                m["category"],
                m.get("source", "unknown"),
                days_old,
            )

            # Combined: RRF is the primary signal, frontal lobe signals can promote/demote.
            # RRF ~0.01-0.03 range, scaled so recency and confidence have real influence
            # on the top 10-20 results (not just tiebreakers).
            combined = (rrf * 12.0 +         # RRF scaled to ~0.12-0.40 range
                        0.25 * recency +
                        0.30 * eff_conf)

            # Source authority boost
            source_weight = SOURCE_WEIGHTS.get(m.get("source", "unknown"), 1.0)
            combined *= source_weight

            results.append((combined, m))

        results.sort(key=lambda x: x[0], reverse=True)

        # Overshoot for contradiction suppression
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
               confidence=None, embedding=None, status=None):
        """Update an existing memory. Can update active or archived memories."""
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
                if status is not None and status in ("active", "archived", "superseded"):
                    m["status"] = status
                    if status != "active":
                        m["archivedAt"] = datetime.utcnow().isoformat() + "Z"
                        m["archiveReason"] = m.get("archiveReason", "manual")
                self._save()
                self._build_index()
                return m
        return None

    def archive_memory(self, memory_id):
        """Explicitly soft-archive a memory by ID. Returns True if found, False otherwise."""
        return self.delete(memory_id)  # delete() is already a soft-archive

    def consolidate_cluster(self, merged_fact, merged_tags, merged_confidence,
                            source_ids, embedding=None):
        """Store a merged/consolidated fact and supersede the source memories.

        Called by the dream mode consolidation phase after LLM rewrites a cluster.
        Source memories are set to status='superseded', not hard-deleted.
        Returns the new consolidated memory record.
        """
        now_iso = datetime.utcnow().isoformat() + "Z"

        # Supersede all source memories
        for m in self.memories:
            if m["id"] in source_ids and m.get("status", "active") == "active":
                m["status"] = "superseded"
                m["archivedAt"] = now_iso
                m["archiveReason"] = "consolidated"

        # Store the merged fact
        mem_id = f"mem_{uuid.uuid4().hex[:8]}"
        record = {
            "id": mem_id,
            "fact": merged_fact[:300],
            "category": self._get_dominant_category(source_ids),
            "tags": [t.lower().strip() for t in merged_tags],
            "source": "consolidation",
            "sourceDate": datetime.utcnow().strftime("%Y-%m-%d"),
            "confidence": min(1.0, merged_confidence),
            "status": "active",
            "supersedes": source_ids[0] if source_ids else None,
            "expires": None,
            "lastAccessed": now_iso,
            "accessCount": 0,
            "embedding": embedding or [],
        }
        self.memories.append(record)
        self._save()
        self._build_index()
        return record

    def _get_dominant_category(self, source_ids):
        """Return the most common category among source memories."""
        from collections import Counter
        cats = []
        for m in self.memories:
            if m["id"] in source_ids:
                cats.append(m.get("category", "general"))
        if not cats:
            return "general"
        return Counter(cats).most_common(1)[0][0]

    def get_consolidation_candidates(self, min_sim=0.55, max_sim=0.70, max_clusters=20):
        """Find clusters of related-but-distinct active memories for consolidation.

        Returns clusters as lists of memory dicts. Each cluster is a candidate for
        LLM rewriting into a single consolidated fact.

        Similarity window: min_sim to max_sim
        - Below 0.55: unrelated (no value in merging)
        - 0.55–0.70: related, worth consolidating
        - 0.70–0.91: auto-supersession range (handled elsewhere)
        - 0.92+: near-duplicate (handled by dedup)

        Protected categories (identity, person, legal) are excluded.
        """
        PROTECTED = {"identity", "person", "legal", "preference"}

        if self._embeddings_matrix is None or len(self.memories) < 2:
            return []

        active_indices = [
            i for i, m in enumerate(self.memories)
            if m.get("status", "active") == "active"
            and m.get("category", "general") not in PROTECTED
        ]
        if len(active_indices) < 2:
            return []

        # Build similarity matrix for active non-protected memories
        mat = self._embeddings_matrix[active_indices]
        sim_matrix = mat @ mat.T

        visited = set()
        clusters = []

        for i_pos, i in enumerate(active_indices):
            if i in visited:
                continue
            cluster = [self.memories[i]]
            visited.add(i)

            for j_pos, j in enumerate(active_indices):
                if j in visited or j == i:
                    continue
                sim = float(sim_matrix[i_pos, j_pos])
                if min_sim <= sim <= max_sim:
                    cluster.append(self.memories[j])
                    visited.add(j)

            if len(cluster) >= 2:
                clusters.append(cluster)
                if len(clusters) >= max_clusters:
                    break

        return clusters

    def delete(self, memory_id):
        """Soft-archive a memory (sets status='archived'). Nothing is ever hard-deleted."""
        now = datetime.utcnow().isoformat() + "Z"
        for m in self.memories:
            if m["id"] == memory_id:
                m["status"] = "archived"
                m["archivedAt"] = now
                m["archiveReason"] = "deleted"
                self._save()
                self._build_index()
                return True
        return False

    def list_all(self, include_embeddings=False, include_archived=False):
        """List memories, optionally without embeddings (for cache sync).

        By default returns only active memories. Pass include_archived=True for
        admin queries (dashboard, archive inspection).
        """
        mems = self.memories if include_archived else [
            m for m in self.memories if m.get("status", "active") == "active"
        ]
        if include_embeddings:
            return mems
        return [{k: v for k, v in m.items() if k != "embedding"} for m in mems]

    def stats(self):
        """Return memory statistics, split by active vs archived."""
        cats = {}
        archived_count = 0
        superseded_count = 0
        for m in self.memories:
            status = m.get("status", "active")
            if status == "archived":
                archived_count += 1
                continue
            if status == "superseded":
                superseded_count += 1
                continue
            c = m.get("category", "general")
            cats[c] = cats.get(c, 0) + 1
        active_count = sum(cats.values())
        return {
            "total": len(self.memories),
            "active": active_count,
            "archived": archived_count,
            "superseded": superseded_count,
            "categories": cats,
            "oldest": min((m["sourceDate"] for m in self.memories if m.get("status", "active") == "active"), default=None),
            "newest": max((m["sourceDate"] for m in self.memories if m.get("status", "active") == "active"), default=None),
        }

    def deduplicate(self, similarity_threshold=DEDUP_THRESHOLD):
        """Find and soft-archive duplicate memories based on vector similarity.

        Keeps the higher-confidence copy; marks the other status='superseded'.
        Superseded memories remain in self.memories but are excluded from active search.
        """
        if self._embeddings_matrix is None or len(self.memories) < 2:
            return 0

        superseded = 0
        to_supersede = set()
        n = len(self.memories)

        for i in range(n):
            if i in to_supersede:
                continue
            # Skip already-inactive memories
            if self.memories[i].get("status", "active") != "active":
                continue
            for j in range(i + 1, n):
                if j in to_supersede:
                    continue
                if self.memories[j].get("status", "active") != "active":
                    continue
                sim = float(np.dot(self._embeddings_matrix[i], self._embeddings_matrix[j]))
                if sim >= similarity_threshold:
                    # Keep the newer or higher-confidence one
                    mi, mj = self.memories[i], self.memories[j]
                    if mi.get("confidence", 0) >= mj.get("confidence", 0):
                        to_supersede.add(j)
                    else:
                        to_supersede.add(i)
                    superseded += 1

        if to_supersede:
            now = datetime.utcnow().isoformat() + "Z"
            for idx in to_supersede:
                self.memories[idx]["status"] = "superseded"
                self.memories[idx]["archivedAt"] = now
                self.memories[idx]["archiveReason"] = "deduplicated"
            self._save()
            self._build_index()

        return superseded

    def archive_expired(self):
        """Soft-archive expired memories — sets status='archived' rather than deleting.

        Archived memories remain in self.memories but are excluded from all active
        searches. Pass search_archive=True to search() to retrieve them.
        """
        now = datetime.utcnow()
        archived = []
        for m in self.memories:
            if m.get("status", "active") != "active":
                continue
            if m.get("expires"):
                try:
                    exp = datetime.strptime(m["expires"], "%Y-%m-%d")
                    if exp < now:
                        archived.append(m)
                except ValueError:
                    pass

        for m in archived:
            m["status"] = "archived"
            m["archivedAt"] = now.isoformat() + "Z"
            m["archiveReason"] = "expired"

        if archived:
            self._save()
            self._build_index()

        return len(archived)

    def expire_old(self):
        """Deprecated alias for archive_expired(). Kept for backwards compatibility."""
        return self.archive_expired()

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
