#!/bin/bash
# llama-swap-main.sh — Swap to daytime VL model
# Stops overnight Coder-30B, starts VL-30B on port 8080
# Idempotent: no-op if main already active

set -euo pipefail

ts() { date '+[%FT%T%z]'; }

# Already running? Skip.
if systemctl is-active --quiet llama-server-main.service 2>/dev/null; then
    logger -t llama-swap "Main VL model already active — skipping swap"
    echo "$(ts) Main VL model already active — skipping swap"
    exit 0
fi

logger -t llama-swap "Swapping to main model (Qwen3-VL-30B-A3B, 32K ctx)"
echo "$(ts) Swapping back to main VL model..."

systemctl stop llama-server-coder.service 2>/dev/null || true
sleep 3
systemctl start llama-server-main.service

echo "$(ts) Main VL model started on :8080 (32K ctx)"

# Wait for model to load (up to 90s)
for i in $(seq 1 18); do
    if curl -sf http://localhost:8080/health > /dev/null 2>&1; then
        logger -t llama-swap "Main model loaded and healthy"
        echo "$(ts) Main model healthy"
        exit 0
    fi
    sleep 5
done

logger -t llama-swap "WARNING: Main model health check timed out after 90s"
echo "$(ts) WARNING: Main model health check timed out"
exit 1
