# Ollama Local Model Benchmark — Pi 5 (8GB)

**Date:** 2026-03-14
**Hardware:** Raspberry Pi 5, 8GB RAM, ARM64 (Cortex-A76)
**Ollama version:** 0.18.0
**Available RAM during test:** ~7.2GB (clawdbot service running)
**Test methodology:** 5 prompt types per model, system prompt included, warm model (pre-loaded). All results use `think: false` to disable reasoning mode where applicable.

---

## Models Tested

| Model | Parameters | Quant | Disk Size |
|-------|-----------|-------|-----------|
| gemma3:1b | 999.89M | Q4_K_M | 815 MB |
| qwen2.5:1.5b | 1.5B | Q4_K_M | 986 MB |
| qwen3:1.7b | 2.0B | Q4_K_M | 1.4 GB |
| llama3.2:1b | 1.24B | Q8_0 | 1.3 GB |
| gemma2:2b | 2.6B | Q4_0 | 1.6 GB |
| qwen3.5:4b | 4.7B | Q4_K_M | 3.4 GB |

---

## Benchmark Results

### Speed Summary

| Model | Avg tok/s | Avg eval (ms) | Avg wall (ms) | Avg response (chars) |
|-------|-----------|---------------|---------------|---------------------|
| **qwen2.5:1.5b** | **11.7** | **5,813** | **7,271** | **314** |
| gemma3:1b | 11.6 | 2,834 | 4,190 | 115 |
| qwen3:1.7b | 7.5 | 7,070 | 8,972 | 187 |
| llama3.2:1b | 7.1 | ~3,576 | ~5,476 | ~153 |
| gemma2:2b | 6.5 | 5,357 | 7,665 | 118 |
| qwen3.5:4b | 2.3 | 21,757 | 29,919 | 213 |

### Detailed Per-Prompt Results

#### gemma3:1b (11.6 tok/s avg)
| Prompt | Tokens | tok/s | Eval ms | Wall ms |
|--------|--------|-------|---------|---------|
| greeting | 12 | 12.0 | 997 | 2,770 |
| short_chat | 29 | 11.2 | 2,590 | 3,565 |
| opinion | 21 | 13.0 | 1,613 | 2,739 |
| longer_reply | 69 | 10.8 | 6,382 | 7,732 |
| personality | 28 | 10.8 | 2,590 | 4,142 |

#### qwen2.5:1.5b (11.7 tok/s avg)
| Prompt | Tokens | tok/s | Eval ms | Wall ms |
|--------|--------|-------|---------|---------|
| greeting | 29 | 11.2 | 2,593 | 4,639 |
| short_chat | 80 | 12.1 | 6,611 | 7,623 |
| opinion | 61 | 11.9 | 5,115 | 6,237 |
| longer_reply | 110 | 11.8 | 9,357 | 10,821 |
| personality | 61 | 11.3 | 5,387 | 7,034 |

#### qwen3:1.7b (7.5 tok/s avg, think:false)
| Prompt | Tokens | tok/s | Eval ms | Wall ms |
|--------|--------|-------|---------|---------|
| greeting | 20 | 8.3 | 2,423 | 5,121 |
| short_chat | 45 | 7.4 | 6,056 | 7,440 |
| opinion | 27 | 7.2 | 3,765 | 5,273 |
| longer_reply | 59 | 7.6 | 7,720 | 9,531 |
| personality | 106 | 6.9 | 15,386 | 17,493 |

#### llama3.2:1b (~7.1 tok/s avg)
| Prompt | Tokens | tok/s | Eval ms | Wall ms |
|--------|--------|-------|---------|---------|
| greeting | 23 | 6.1 | 3,787 | 5,622 |
| personality | 35 | 7.3 | 4,789 | 5,783 |
| opinion | 33 | 7.9 | 4,151 | 5,025 |

#### gemma2:2b (6.5 tok/s avg)
| Prompt | Tokens | tok/s | Eval ms | Wall ms |
|--------|--------|-------|---------|---------|
| greeting | 16 | 6.9 | 2,305 | 5,571 |
| short_chat | 62 | 6.3 | 9,808 | 11,484 |
| opinion | 22 | 6.4 | 3,431 | 5,145 |
| longer_reply | 55 | 6.7 | 8,253 | 10,537 |
| personality | 19 | 6.4 | 2,988 | 5,590 |

#### qwen3.5:4b (2.3 tok/s avg, think:false)
| Prompt | Tokens | tok/s | Eval ms | Wall ms |
|--------|--------|-------|---------|---------|
| greeting | 33 | 2.3 | 14,392 | 21,608 |
| short_chat | 80 | 2.3 | 35,287 | 42,761 |
| opinion | 30 | 2.3 | 13,302 | 21,221 |
| longer_reply | 46 | 2.3 | 20,171 | 28,741 |
| personality | 58 | 2.3 | 25,634 | 35,264 |

---

## Response Quality Comparison (personality prompt)

> Prompt: "You're a witty British assistant. Someone just sent you a photo of a cat wearing a hat. React in character."

**gemma3:1b:**
> "Right then. Let's see. Don't tell me you've *actually* done this? Honestly."

**qwen2.5:1.5b:**
> "Oh dear, I can't imagine that's the most fashionable choice for our feline friend. Cats are purrsolutely independent when it comes to clothing, so perhaps this is one too many nods to style? But then..."

**qwen3:1.7b:**
> "*snaps a photo of a cat wearing a hat* 'Ah, the eternal fashionista. A cat in a hat -- what a masterpiece. I'm sure it's a contender for Most Unlikely Celebrity.'"

**llama3.2:1b:**
> "Hmmph, a cat in a hat? How original. I'm surprised it didn't have a speech bubble saying 'I'm feline fine' or something."

**gemma2:2b:**
> "Right then, what is the *purpose* of this?"

**qwen3.5:4b:**
> "Ah, the feline aristocracy has made a bold fashion statement. A cat in a hat? Absolutely ridiculous, yet somehow the only thing sensible in this house. I suppose I should be jealous. Tell me, did he w..."

---

## Issues Found

### Qwen 3.x / 3.5 Thinking Mode
Both qwen3:1.7b and qwen3.5:4b use a "thinking" mode by default that generates internal reasoning tokens before producing visible output. Without `think: false`:
- All token budget consumed by invisible reasoning
- `message.content` returns empty string
- `message.thinking` contains the reasoning text
- **Fix:** Add `"think": false` to the Ollama API request body

### Model Cold-Load Times
First request after model swap takes 15-20s for model loading. Subsequent warm requests use cached model in RAM. Ollama keeps the last-used model warm by default.

---

## Recommendation

### Winner: qwen2.5:1.5b

| Criterion | Result |
|-----------|--------|
| Speed | 11.7 tok/s (fastest, tied with gemma3:1b) |
| Response length | 314 avg chars (longest -- 2.7x more than gemma3:1b) |
| Response quality | Good conversational ability, follows personality prompts well |
| Disk | 986 MB |
| RAM | ~1.5 GB loaded |
| No thinking mode issues | Correct -- no `think` parameter needed |
| Timeout safe | 50-token response = ~4.3s, 100-token = ~8.5s, well within 15s |

### Why not the others?

- **gemma3:1b** -- Equally fast but responses are too terse (115 avg chars). Fine for simple acknowledgements but lacks the personality depth needed for a chatbot.
- **qwen3:1.7b** -- 36% slower (7.5 tok/s) and requires `think: false` workaround. Response quality is good but not worth the speed penalty.
- **llama3.2:1b** -- 39% slower (7.1 tok/s). Decent quality but no advantage over qwen2.5.
- **gemma2:2b** -- 44% slower (6.5 tok/s) with terse responses. Worst of both worlds.
- **qwen3.5:4b** -- 80% slower (2.3 tok/s). Best quality responses but completely impractical. A 100-token response takes ~43s. Would timeout on most queries.

### Configuration Applied

```env
OLLAMA_ENABLED=true
OLLAMA_MODEL=qwen2.5:1.5b
OLLAMA_TIMEOUT=15000
OLLAMA_MAX_TOKENS=300
```

### Latency Budget

For a typical conversational message routed to the local model:
- Prompt evaluation: ~1-2s
- Token generation (30-60 tokens): 2.5-5s
- **Total wall time: 3.5-7s** -- acceptable for WhatsApp where typing indicators provide natural delay

For the configured 300-token maximum:
- Worst case: ~25s (would hit 15s timeout)
- In practice: model self-terminates at natural sentence boundaries, typically 30-80 tokens

---

## Disk Usage on Pi

After benchmark (all models present):
```
gemma3:1b        815 MB
qwen2.5:1.5b    986 MB
qwen3:1.7b      1.4 GB
llama3.2:1b      1.3 GB
gemma2:2b        1.6 GB
qwen3.5:4b       3.4 GB
moondream:latest  1.7 GB
```
**Total: ~11.2 GB**

Consider removing unused models to free space:
```bash
ollama rm qwen3.5:4b gemma2:2b llama3.2:1b
```
This would free ~6.3 GB, leaving qwen2.5:1.5b (primary), gemma3:1b (backup fast model), qwen3:1.7b (backup quality model), and moondream (vision).
