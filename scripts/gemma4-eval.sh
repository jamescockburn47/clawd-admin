#!/bin/bash
# gemma4-eval.sh — Download and benchmark Gemma 4 models on EVO X2
#
# Run on EVO: bash ~/clawdbot/scripts/gemma4-eval.sh
#
# Downloads Gemma 4 26B MoE (Q4_K_M) and E4B (Q8_0) GGUFs,
# then benchmarks against current Qwen3-VL-30B-A3B and Qwen3-0.6B.
#
# WARNING: Check if Gemma 4 26B MoE uses GDN architecture before sustained use.
# GDN causes GPU hangs on gfx1151 under sustained load (see CLAUDE.md #15).

set -euo pipefail

MODEL_DIR="$HOME/models"
LLAMA_SERVER="/usr/local/bin/llama-server"
LLAMA_BENCH="/usr/local/bin/llama-bench"

mkdir -p "$MODEL_DIR/gemma4"

echo "=== Gemma 4 Evaluation for EVO X2 (Ryzen AI MAX+ 395 / Radeon 8060S) ==="
echo ""

# ── Step 1: Download models ──────────────────────────────────────────────────

echo "[1/4] Downloading Gemma 4 26B MoE Q4_K_M (3.8B active, ~18GB)..."
if [ ! -f "$MODEL_DIR/gemma4/gemma-4-26b-it-Q4_K_M.gguf" ]; then
  wget -q --show-progress -O "$MODEL_DIR/gemma4/gemma-4-26b-it-Q4_K_M.gguf" \
    "https://huggingface.co/unsloth/gemma-4-26B-it-GGUF/resolve/main/gemma-4-26B-it-Q4_K_M.gguf"
else
  echo "  Already downloaded."
fi

echo ""
echo "[2/4] Downloading Gemma 4 E4B Q8_0 (classifier candidate, ~5GB)..."
if [ ! -f "$MODEL_DIR/gemma4/gemma-4-E4B-it-Q8_0.gguf" ]; then
  wget -q --show-progress -O "$MODEL_DIR/gemma4/gemma-4-E4B-it-Q8_0.gguf" \
    "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q8_0.gguf"
else
  echo "  Already downloaded."
fi

# ── Step 2: Benchmark with llama-bench ───────────────────────────────────────

echo ""
echo "[3/4] Running benchmarks (prompt processing + text generation)..."
echo ""
echo "--- Gemma 4 26B MoE (Q4_K_M) ---"
if [ -x "$LLAMA_BENCH" ]; then
  $LLAMA_BENCH \
    -m "$MODEL_DIR/gemma4/gemma-4-26b-it-Q4_K_M.gguf" \
    -p 512 -n 128 -ngl 99 \
    2>&1 | tail -20

  echo ""
  echo "--- Gemma 4 E4B (Q8_0) ---"
  $LLAMA_BENCH \
    -m "$MODEL_DIR/gemma4/gemma-4-E4B-it-Q8_0.gguf" \
    -p 512 -n 128 -ngl 99 \
    2>&1 | tail -20

  echo ""
  echo "--- Current: Qwen3-VL-30B-A3B (Q4_K_M) ---"
  QWEN_MODEL=$(find "$MODEL_DIR" -name "*Qwen3-VL*Q4_K_M*" -type f | head -1)
  if [ -n "$QWEN_MODEL" ]; then
    $LLAMA_BENCH \
      -m "$QWEN_MODEL" \
      -p 512 -n 128 -ngl 99 \
      2>&1 | tail -20
  else
    echo "  Qwen3-VL model not found for comparison."
  fi
else
  echo "  llama-bench not found at $LLAMA_BENCH — skipping benchmarks."
  echo "  You can run manually: llama-bench -m <model> -p 512 -n 128 -ngl 99"
fi

# ── Step 3: Quick functional test ────────────────────────────────────────────

echo ""
echo "[4/4] Quick functional test — classification with Gemma 4 E4B..."
echo ""

# Start a temporary server for testing
TEMP_PORT=8099
echo "Starting temporary server on port $TEMP_PORT..."
$LLAMA_SERVER \
  -m "$MODEL_DIR/gemma4/gemma-4-E4B-it-Q8_0.gguf" \
  --port $TEMP_PORT \
  -ngl 99 \
  --flash-attn on \
  -c 4096 \
  --log-disable \
  &
SERVER_PID=$!
sleep 5

echo "Testing classification prompt..."
RESULT=$(curl -s http://localhost:$TEMP_PORT/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "system", "content": "Classify the user message into exactly one category: conversational, calendar, email, todo, recall, planning, legal, web, travel, document, general_knowledge, image. Output JSON: {\"category\": \"...\", \"needsPlan\": true/false}"},
      {"role": "user", "content": "whats on my calendar tomorrow"}
    ],
    "temperature": 0.1,
    "max_tokens": 50
  }')
echo "Response: $RESULT"

echo ""
echo "Testing reasoning prompt..."
RESULT2=$(curl -s http://localhost:$TEMP_PORT/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "What is 15% of 340? Answer in one line."}
    ],
    "temperature": 0.1,
    "max_tokens": 50
  }')
echo "Response: $RESULT2"

# Clean up
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true

echo ""
echo "=== Evaluation complete ==="
echo ""
echo "Next steps:"
echo "  1. Compare tok/s against Qwen3-VL-30B-A3B (~60-70 tok/s on Vulkan)"
echo "  2. Check if Gemma 4 26B uses GDN — if yes, DO NOT use for overnight sessions"
echo "  3. If E4B classification is good, consider replacing Qwen3-0.6B (port 8081)"
echo "  4. If 26B MoE beats Qwen3-VL-30B, update llama-swap-main.sh model path"
echo ""
echo "Model files saved to: $MODEL_DIR/gemma4/"
