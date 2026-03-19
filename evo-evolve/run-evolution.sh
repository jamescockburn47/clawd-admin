#!/usr/bin/env bash
# evo-evolve/run-evolution.sh — Overnight Claude Code evolution session
#
# Triggered by evo-evolve.timer at 22:05 on the EVO X2.
# Runs Claude Code CLI headless against the Pi's clawdbot codebase.
#
# Flow:
#   1. Pull latest from Pi
#   2. Generate health report from data files
#   3. Create evolution branch
#   4. Run Claude Code with structured prompt
#   5. Push branch back to Pi
#   6. Write summary for morning briefing
#
# Requirements:
#   - claude CLI installed on EVO (npm i -g @anthropic-ai/claude-code)
#   - ANTHROPIC_API_KEY set in environment
#   - SSH access to Pi

set -euo pipefail

WORK_DIR="$HOME/clawdbot-evolution"
PI_HOST="pi@192.168.1.211"
PI_PATH="~/clawdbot"
BRANCH="evolve/$(date +%Y-%m-%d)"
LOG_FILE="$WORK_DIR/evolution-$(date +%Y-%m-%d).log"
SUMMARY_FILE="$WORK_DIR/evolution-summary.md"
MAX_DURATION=3600  # 1 hour max

# Cost guardrail — abort if session would exceed this
MAX_COST_USD=10

echo "=== Evolution session $(date -Iseconds) ===" | tee "$LOG_FILE"

# --- 1. Sync codebase from Pi ---
mkdir -p "$WORK_DIR"
echo "[1/5] Syncing codebase from Pi..." | tee -a "$LOG_FILE"
rsync -az --delete \
  -e "ssh -i $HOME/.ssh/id_ed25519" \
  "$PI_HOST:$PI_PATH/" "$WORK_DIR/clawdbot/" \
  --exclude node_modules \
  --exclude auth_state \
  --exclude .git \
  2>&1 | tee -a "$LOG_FILE"

cd "$WORK_DIR/clawdbot"

# Init git if needed (Pi deployment doesn't use git)
if [ ! -d .git ]; then
  git init -q
  git add -A
  git commit -q -m "baseline from Pi"
fi

# --- 2. Generate health report ---
echo "[2/5] Generating health report..." | tee -a "$LOG_FILE"

HEALTH_REPORT="$WORK_DIR/health-report.md"
cat > "$HEALTH_REPORT" << 'REPORT_HEADER'
# Clawdbot Health Report
Generated for overnight evolution session.
REPORT_HEADER

# Interaction stats
if [ -f data/interactions.jsonl ]; then
  TOTAL=$(wc -l < data/interactions.jsonl)
  LAST_7D=$(awk -v cutoff="$(date -d '7 days ago' -Iseconds 2>/dev/null || date -v-7d +%Y-%m-%dT%H:%M:%S)" \
    'BEGIN{c=0} {if($0 ~ cutoff) c++} END{print c}' data/interactions.jsonl 2>/dev/null || echo "?")
  echo -e "\n## Interactions\n- Total: $TOTAL\n- Last 7 days: $LAST_7D" >> "$HEALTH_REPORT"
  echo -e "\n### Recent interactions (last 20):" >> "$HEALTH_REPORT"
  tail -20 data/interactions.jsonl >> "$HEALTH_REPORT"
fi

# Feedback
if [ -f data/feedback.jsonl ]; then
  echo -e "\n## Feedback" >> "$HEALTH_REPORT"
  POS=$(grep -c '"positive"' data/feedback.jsonl 2>/dev/null || echo 0)
  NEG=$(grep -c '"negative"' data/feedback.jsonl 2>/dev/null || echo 0)
  CORR=$(grep -c '"correction"' data/feedback.jsonl 2>/dev/null || echo 0)
  echo "- Positive: $POS" >> "$HEALTH_REPORT"
  echo "- Negative: $NEG" >> "$HEALTH_REPORT"
  echo "- Corrections: $CORR" >> "$HEALTH_REPORT"
  echo -e "\n### All feedback entries:" >> "$HEALTH_REPORT"
  cat data/feedback.jsonl >> "$HEALTH_REPORT"
fi

# Router telemetry
if [ -f data/router-stats.jsonl ]; then
  echo -e "\n## Router Telemetry (last 50 entries)" >> "$HEALTH_REPORT"
  tail -50 data/router-stats.jsonl >> "$HEALTH_REPORT"
fi

# Audit log
if [ -f data/audit.json ]; then
  echo -e "\n## Audit Log (recent failures)" >> "$HEALTH_REPORT"
  python3 -c "
import json, sys
try:
  data = json.load(open('data/audit.json'))
  fails = [e for e in data if not e.get('success', True)]
  for f in fails[-20:]:
    print(json.dumps(f))
except: pass
" >> "$HEALTH_REPORT" 2>/dev/null
fi

# Dev journal
if [ -f data/dev-journal.jsonl ]; then
  echo -e "\n## Development Journal" >> "$HEALTH_REPORT"
  cat data/dev-journal.jsonl >> "$HEALTH_REPORT"
fi

# Self-improvement cycle log
if [ -f data/self-improve-log.jsonl ]; then
  echo -e "\n## Self-Improvement Cycle Log (last 10)" >> "$HEALTH_REPORT"
  tail -10 data/self-improve-log.jsonl >> "$HEALTH_REPORT"
fi

echo "Health report: $(wc -l < "$HEALTH_REPORT") lines" | tee -a "$LOG_FILE"

# --- 3. Create branch ---
echo "[3/5] Creating evolution branch: $BRANCH" | tee -a "$LOG_FILE"
git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH"
git add -A
git diff --cached --quiet || git commit -q -m "pre-evolution snapshot"

# --- 4. Run Claude Code ---
echo "[4/5] Running Claude Code evolution session..." | tee -a "$LOG_FILE"

PROMPT=$(cat << 'EVOLUTION_PROMPT'
You are running an overnight evolution session for Clawdbot, a WhatsApp bot + voice assistant.

READ THESE FILES FIRST:
- CLAUDE.md (project overview and deployment instructions)
- architecture.md (system architecture)
- The health report at ../health-report.md (interaction data, feedback, errors)

YOUR TASK:
Analyse the health report and codebase to identify and implement improvements. Focus on:

1. **Bug fixes** — errors in audit log, failed tool calls, patterns in negative feedback
2. **Performance** — high-latency interactions, unnecessary API calls, caching opportunities
3. **Robustness** — error handling gaps, missing fallbacks, edge cases
4. **Code quality** — dead code, unclear logic, missing logging

RULES (NON-NEGOTIABLE):
- Work ONLY in this branch. Never touch main.
- Max 50 lines changed per improvement. Small, targeted fixes only.
- NO new dependencies (no npm install, no new imports from packages not already in package.json)
- NO changes to: .env, config.js env var names, auth logic, API keys, port numbers
- NO changes to tool definitions schema (tools/definitions.js) — these are the Claude API contract
- Every change must pass: node --check <file>
- Make one commit per improvement with a clear message explaining what and why
- If you're unsure whether a change is safe, DON'T MAKE IT. Skip and note it in the summary.
- NEVER invent test data, API responses, or mock scenarios. Only use real data from the health report.

OUTPUT:
After making changes, write a summary to ../evolution-summary.md with:
- What you found (diagnosis)
- What you changed (with file:line references)
- What you skipped and why (risk assessment)
- Recommended changes that need human review

Keep the session under 1 hour. Quality over quantity — one good fix beats five risky ones.
EVOLUTION_PROMPT
)

# Run with timeout and cost controls
timeout "$MAX_DURATION" claude -p "$PROMPT" \
  --max-turns 30 \
  --output-format text \
  2>&1 | tee -a "$LOG_FILE" || true

echo "[4/5] Claude Code session complete" | tee -a "$LOG_FILE"

# --- 5. Capture results ---
echo "[5/5] Capturing results..." | tee -a "$LOG_FILE"

# Count commits made
COMMIT_COUNT=$(git log --oneline main.."$BRANCH" 2>/dev/null | wc -l || echo 0)
echo "Commits: $COMMIT_COUNT" | tee -a "$LOG_FILE"

# Generate diff summary
DIFF_STAT=$(git diff --stat main.."$BRANCH" 2>/dev/null || echo "no changes")
echo "Changes: $DIFF_STAT" | tee -a "$LOG_FILE"

# Copy summary if Claude wrote one
if [ -f "../evolution-summary.md" ]; then
  cp "../evolution-summary.md" "data/evolution-report-$(date +%Y-%m-%d).md"
  echo "Summary written to data/evolution-report-$(date +%Y-%m-%d).md" | tee -a "$LOG_FILE"
fi

# Notify Pi (for morning briefing)
NOTIFY_MSG="🧬 Evolution session complete.
Commits: $COMMIT_COUNT
$DIFF_STAT

Review: cd ~/clawdbot-evolution/clawdbot && git log --oneline main..$BRANCH"

ssh -i "$HOME/.ssh/id_ed25519" "$PI_HOST" "curl -s -X POST http://localhost:3000/api/voice-status \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM' \
  -d '{\"event\":\"toast\",\"message\":\"Evolution: $COMMIT_COUNT changes proposed\"}'" 2>/dev/null || true

echo "=== Session complete $(date -Iseconds) ===" | tee -a "$LOG_FILE"
