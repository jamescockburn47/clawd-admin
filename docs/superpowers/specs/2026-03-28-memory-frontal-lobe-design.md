# Memory Frontal Lobe — Intelligent Scoring & Contradiction Suppression

**Date:** 2026-03-28
**Status:** Design
**Scope:** memory-service/memory_store.py (EVO), minor touch to src/memory.js (Pi)

## Problem

Clawd cited outdated architecture in a group chat ("Ollama", "qwen3:0.6b") because:

1. Stale system knowledge entries had `confidence: 1.0` and high `accessCount`, giving them top scores
2. The scoring algorithm is source-blind — a dream diary extraction scores identically to authoritative system knowledge
3. No mechanism detects contradictions between memories covering the same topic
4. Frequency score rewards stale memories that happened to be accessed often historically

The root seeding bug is fixed. This design prevents the class of problem.

## Design

Four changes to `memory_store.py`. No new files, no new endpoints, no additional LLM calls.

### 1. Source-Weight Boost

Add a multiplier to the combined score based on memory source. Authoritative sources score higher.

```python
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
```

Applied as: `combined = base_score * SOURCE_WEIGHTS.get(source, 1.0)`

**Why these values:** System knowledge is the canonical truth about Clawd's own architecture — it should always win on self-referential queries. Manual notes are explicit human input. Dream/diary extractions are inferred and less reliable.

The boost is multiplicative so it doesn't override a genuinely irrelevant system knowledge entry (low base score × 1.25 still loses to a highly relevant conversation memory).

### 2. Confidence Decay Over Time

Currently, confidence is stored once and never changes. A memory stored at `confidence: 0.9` six months ago scores identically to one stored today.

Add a computed `effective_confidence` that decays with age — but **only for categories that describe mutable state**. Stable facts (preferences, people, legal knowledge, identity) never decay. This is intelligent ageing, not dementia.

**Principle: decay targets volatility, not age.** "James prefers no emojis" is just as true at 180 days as at day 1. "EVO runs Ollama" becomes suspect after 30 days if nothing has refreshed it.

```python
# Categories where facts describe mutable/volatile state — decay applies
VOLATILE_CATEGORIES = {
    "system": 30,        # Architecture/infra: halves every 30 days
    "schedule": 7,       # Schedule info: stale fast
    "travel": 14,        # Trip plans: short shelf life
    "accommodation": 60, # Bookings: medium shelf life
    "henry": 30,         # Weekend plans: short-medium
    "dream": 45,         # Dream extractions: inferred, fade
    "document_chunk": 60,# Doc fragments: medium
}

# Categories where facts are stable/permanent — NO decay ever
# identity, preference, person, legal, ai_consultancy, document,
# document_index, insight, general (see below)
#
# "general" is a mixed bag — decay depends on SOURCE, not category:
EPHEMERAL_SOURCES = {"diary_extraction", "diary_insight", "dream_mode", "image_analysis"}

days_old = (now - created).days
category = m["category"]
source = m.get("source", "unknown")

half_life = VOLATILE_CATEGORIES.get(category)

# General memories only decay if from an ephemeral source
if category == "general" and source in EPHEMERAL_SOURCES:
    half_life = 60  # Inferred general facts fade over 60 days
elif category == "general":
    half_life = None  # Explicit general facts (conversation, manual) are stable

if half_life and days_old > 0:
    effective_confidence = confidence * (0.5 ** (days_old / half_life))
else:
    effective_confidence = confidence  # No decay — full stored confidence
```

**What decays:** system (30d), schedule (7d), travel (14d), accommodation (60d), henry (30d), dream (45d), document_chunk (60d), and general memories from ephemeral sources (60d).

**What never decays:** identity, preference, person, legal, ai_consultancy, document, document_index, insight, and general memories from conversation/manual_note/api sources.

Since system knowledge is re-seeded nightly, fresh entries always have full confidence. Stale orphans that somehow survive the wipe decay naturally. But a preference or legal fact stays at full strength indefinitely — as it should.

**Integration into scoring formula:**

The current formula is:
```
combined = 0.35 × keyword + 0.40 × vector + 0.15 × recency + 0.10 × frequency
```

Replace `frequency` component (which rewards stale popular memories) with `effective_confidence`:
```
combined = 0.30 × keyword + 0.40 × vector + 0.10 × recency + 0.20 × effective_confidence
```

Changes:
- `keyword`: 0.35 → 0.30 (slight reduction — vector is more reliable)
- `vector`: 0.40 → 0.40 (unchanged, primary signal)
- `recency`: 0.15 → 0.10 (reduced — confidence decay already encodes staleness)
- `frequency` (0.10): **removed entirely** — access count rewarded stale memories and created a feedback loop
- `effective_confidence`: **new at 0.20** — directly rewards authoritative, fresh memories

Then source weight applies: `combined *= SOURCE_WEIGHTS.get(source, 1.0)`

### 3. Contradiction Suppression

After scoring and sorting, before returning results, scan the top N results for contradictions and suppress losers.

**Algorithm:**

```python
def _suppress_contradictions(self, results, suppression_threshold=0.75):
    """Remove lower-ranked memories that contradict higher-ranked ones on the same topic."""
    if len(results) < 2:
        return results

    kept = []
    suppressed_embeddings = []

    for score, mem in results:
        # Check if this memory's embedding is very similar to an already-kept memory
        # (same topic) but from a different/older source (contradiction candidate)
        dominated = False
        if mem.get("embedding") and suppressed_embeddings:
            mvec = np.array(mem["embedding"], dtype=np.float32)
            mnorm = np.linalg.norm(mvec)
            if mnorm > 0:
                mvec = mvec / mnorm
                for kept_vec, kept_mem in suppressed_embeddings:
                    sim = float(np.dot(mvec, kept_vec))
                    if sim >= suppression_threshold:
                        # Same topic, but this one scored lower — suppress it
                        dominated = True
                        break

        if not dominated:
            kept.append((score, mem))
            # Track this memory's embedding for future suppression checks
            if mem.get("embedding"):
                evec = np.array(mem["embedding"], dtype=np.float32)
                enorm = np.linalg.norm(evec)
                if enorm > 0:
                    evec = evec / enorm
                    suppressed_embeddings.append((evec, mem))

    return kept
```

**How it works:** Results are already sorted by score (best first). For each candidate, check if it's semantically very similar (≥ 0.75 cosine) to an already-accepted memory. If so, it's a lower-scoring duplicate or contradiction on the same topic — suppress it. The higher-scoring memory (which benefits from source weight + fresh confidence) wins.

**Threshold 0.75:** Lower than the dedup threshold (0.92) because contradictions aren't exact duplicates — "EVO runs Ollama" and "EVO runs llama-server" are about the same topic but differ in content. 0.75 catches topical overlap without suppressing genuinely different memories.

**Suppression limit:** Only applies within the initial result set (default limit × 1.5, rounded up). We fetch more candidates than needed, suppress, then trim to the requested limit. This ensures the caller still gets `limit` results even after suppression removes some.

### Fetch Overshoot

To compensate for suppression removing results, the search fetches `ceil(limit * 1.5)` candidates before suppression, then trims to `limit` after:

```python
overshoot_limit = min(len(self.memories), int(limit * 1.5) + 1)
# ... score all, sort, take top overshoot_limit
# ... suppress contradictions
# ... trim to limit (if fewer remain after suppression, return what we have)
```

If suppression leaves fewer than `limit` results, return all surviving results. This is acceptable — returning 6 highly relevant non-contradictory memories is better than padding to 8 with contradictions.

### 4. Auto-Supersession at Store Time

The `supersedes` field exists in every memory record but is only used when explicitly passed by the caller. Nobody ever passes it. This activates the dormant infrastructure.

**Problem:** Active projects generate evolving facts. "LQ business model: subscription SaaS" gets stored on March 10, then "LQ business model: marketplace commission" on March 28. Both survive, both reach the prompt, Clawd doesn't know which is current.

**Solution:** After the pre-store dedup check (which catches near-identical facts at ≥ 0.92), add a **supersession check** in the 0.70–0.91 similarity range. Same topic, different content = the new fact updates the old one.

```python
# Supersession constants
SUPERSESSION_THRESHOLD_LOW = 0.70   # Must be same topic
SUPERSESSION_THRESHOLD_HIGH = 0.91  # Below dedup (0.92) — not identical, but related

def _check_supersession(self, embedding, category, source):
    """Find an existing memory that the new one should supersede."""
    if (not embedding or category in PROTECTED_CATEGORIES
            or self._embeddings_matrix is None or len(self.memories) == 0):
        return None

    qvec = np.array(embedding, dtype=np.float32)
    qnorm = np.linalg.norm(qvec)
    if qnorm <= 0:
        return None

    qvec = qvec / qnorm
    similarities = self._embeddings_matrix @ qvec

    # Find best match in supersession range
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
            new_date = datetime.utcnow()
            if new_date < old_date:
                return None  # Old memory is actually newer — don't supersede
        except (ValueError, KeyError):
            pass
        return candidate["id"]

    return None
```

**Integration into `store()`:** Called after the dedup check. If a supersession target is found and the caller didn't already pass `supersedes`, auto-set it:

```python
# After dedup check passes (no duplicate found)...
if not supersedes:
    auto_supersedes = self._check_supersession(embedding, safe_category, source)
    if auto_supersedes:
        supersedes = auto_supersedes
        logger.info(f"Auto-supersession: new fact supersedes {auto_supersedes}")
```

The existing `supersedes` handling already archives the old memory — no new code needed for that path.

**Constraints:**
- **Same category only.** "James likes Italian" (preference) won't supersede "LQ catering: Italian" (ai_consultancy).
- **Protected categories exempt.** Identity memories are never auto-superseded.
- **Newer wins.** If batch extraction stores an older fact, it won't supersede a newer one.
- **Explicit supersedes takes priority.** If the caller passes `supersedes`, the auto-check is skipped.
- **Logged.** Every auto-supersession is logged so overnight trace analysis can monitor for false positives.

## What Does NOT Change

- **Memory storage format** — no schema changes, `supersedes` field already exists
- **API endpoints** — same request/response shapes
- **Pi-side code** — `src/memory.js` search calls and cache are unchanged
- **System knowledge seeding** — still wipe-and-reseed nightly at 2 AM
- **Dedup threshold** — stays at 0.92 for pre-store and batch
- **Protected categories** — identity still never expires, never decays, never auto-superseded
- **Token budget** — stays at 12,000 chars (~3,000 tokens)

## Scoring Example

**Query:** "how does your architecture work?"

**Memory A:** "EVO runs Ollama for embeddings" — category: `general`, source: `diary_extraction`, 20 days old, confidence 0.85, accessCount 12
- general + diary_extraction = ephemeral source → half_life 60 days
- keyword: 0.15, vector: 0.55, recency: max(0, 1-20/90)=0.78, eff_confidence: 0.85×(0.5^(20/60))=0.67
- base = 0.30×0.15 + 0.40×0.55 + 0.10×0.78 + 0.20×0.67 = 0.045 + 0.22 + 0.078 + 0.134 = 0.477
- × source weight 0.95 = **0.453**

**Memory B:** "EVO X2 runs llama-server on port 8080, nomic-embed-text on port 8083" — source: `system_knowledge`, 0 days old, confidence 1.0, accessCount 2
- keyword: 0.10, vector: 0.60, recency: 1.0, eff_confidence: 1.0 (no decay, 0 days)
- base = 0.30×0.10 + 0.40×0.60 + 0.10×1.0 + 0.20×1.0 = 0.03 + 0.24 + 0.10 + 0.20 = 0.57
- × source weight 1.25 = **0.713**

Memory B wins decisively. And if both appear in results, contradiction suppression drops Memory A (same topic, lower score, cosine similarity ~0.80 between the two embeddings).

Under the **old** formula, Memory A would score: 0.35×0.15 + 0.40×0.55 + 0.15×0.78 + 0.10×min(1.0, 12/10) = 0.053 + 0.22 + 0.117 + 0.10 = **0.49**. Memory B: 0.35×0.10 + 0.40×0.60 + 0.15×1.0 + 0.10×min(1.0, 2/10) = 0.035 + 0.24 + 0.15 + 0.02 = **0.445**. Memory A wins — wrong answer served.

## Files Modified

| File | Change |
|------|--------|
| `memory-service/memory_store.py` | Add `SOURCE_WEIGHTS`, `VOLATILE_CATEGORIES`, modify `search()` scoring, add `_suppress_contradictions()`, add `_check_supersession()`, modify `store()` |

One file. ~100 lines of new/changed code.

## Testing

- Unit tests for `effective_confidence` decay calculation (known inputs → known outputs)
- Unit test for contradiction suppression (two similar memories, different sources, verify winner kept)
- Unit test for source weight application (system_knowledge scores higher than conversation for same base)
- Unit test for auto-supersession (store two same-topic memories, verify old one archived)
- Unit test for supersession guards (different category = no supersession, protected category = no supersession, older fact = no supersession)
- Integration: store two contradicting memories, search, verify only the authoritative one returns
- Regression: existing search behaviour preserved for non-conflicting memories

## Risks

- **Suppression threshold too aggressive (0.75):** Could suppress genuinely different memories that happen to be about related topics. Mitigation: start at 0.75, monitor via overnight trace analysis, tune if needed.
- **Confidence decay too fast for system category:** 30-day half-life means a system memory not re-seeded for 60 days scores at 0.25. This is intentional — system knowledge should be re-seeded nightly. If the seeder is broken, this surfaces the problem rather than hiding it. Stable categories (identity, preference, person, legal, insight) are immune — they never decay.
- **Source weight unfairness:** A bad system_knowledge entry (from a buggy seeder) gets boosted. Mitigation: the seeding bug is already fixed, and system knowledge is regenerated from a validated JSON document.

## Design Decisions to Add to CLAUDE.md

131. **Memory scoring uses source weights.** system_knowledge × 1.25, conversation × 1.0, dream × 0.90. Authoritative sources win ties.
132. **Confidence decays for volatile categories only.** system (30d), schedule (7d), travel (14d), dream (45d), general-from-ephemeral-sources (60d). Stable categories (identity, preference, person, legal, insight) never decay — intelligent ageing, not dementia.
133. **Contradiction suppression at retrieval.** Cosine ≥ 0.75 between results = same topic. Lower-scoring entry dropped. Prevents conflicting memories both reaching the prompt.
134. **Frequency score removed from search.** Access count created feedback loops rewarding stale popular memories. Replaced by effective_confidence.
135. **Auto-supersession at store time.** New memories with 0.70–0.91 cosine similarity to existing same-category memories auto-supersede the older one. Protected categories exempt. Activates the dormant `supersedes` field.
