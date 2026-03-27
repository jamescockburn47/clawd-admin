#!/bin/bash
# llama-swap-coder.sh — Swap to overnight coder model
# Stops daytime VL-30B, starts Coder-30B on port 8080
# Idempotent: no-op if coder already active

set -euo pipefail

ts() { date '+[%FT%T%z]'; }

# Already running? Skip.
if systemctl is-active --quiet llama-server-coder.service 2>/dev/null; then
    logger -t llama-swap "Coder model already active — skipping swap"
    echo "$(ts) Coder model already active — skipping swap"
    exit 0
fi

logger -t llama-swap "Swapping to coder model (Qwen3-Coder-30B-A3B, 64K ctx)"
echo "$(ts) Swapping to coding model..."

systemctl stop llama-server-main.service 2>/dev/null || true
sleep 3
systemctl start llama-server-coder.service

echo "$(ts) Coding model started on :8080 (128K ctx)"

# Wait for model to load (up to 90s — 64K ctx takes longer)
for i in $(seq 1 18); do
    if curl -sf http://localhost:8080/health > /dev/null 2>&1; then
        logger -t llama-swap "Coder model loaded and healthy"
        echo "$(ts) Coding model healthy"
        exit 0
    fi
    sleep 5
done

logger -t llama-swap "WARNING: Coder model health check timed out after 90s"
echo "$(ts) WARNING: Coder model health check timed out"
exit 1
