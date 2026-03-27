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
You are running an overnight evolution session for Clawdbot.

READ EVOLUTION.md FIRST — it contains the hard rules you must follow.

Then read the health report at ../health-report.md for interaction data, feedback, and errors.

YOUR TASK:
Pick the SINGLE most impactful fix from the health report. Do NOT batch multiple fixes.

SCOPE RULES (HARD — VIOLATION = SESSION FAILURE):
- You may ONLY modify files under src/ or eval/
- NEVER modify: CLAUDE.md, EVOLUTION.md, .env, package.json, package-lock.json
- NEVER modify anything in: data/, auth_state/, .claude/, evo-hooks/, node_modules/, docs/
- Maximum 5 files changed total
- Maximum 150 lines changed total (insertions + deletions)
- NO new dependencies
- NO changes to: config.js env var names, tool definition schemas, port numbers, API endpoints, auth logic
- One commit only with a clear message
- If your fix needs more than 5 files or 150 lines, STOP and write why in the summary. Do not proceed.

PROCESS:
1. Read the health report and identify the single highest-impact issue
2. Read the relevant source files
3. Implement the fix (within scope limits)
4. Run: node --check <file> for every file you changed
5. Commit with a clear message

OUTPUT:
Write a summary to ../evolution-summary.md with:
- What you found (one issue, from health report data)
- What you changed (file:line references)
- What you skipped and why
EVOLUTION_PROMPT
)

# Write scope file for PreToolUse hook (allows all src/ and eval/ for overnight)
echo '{"allowed_files": ["src/*", "eval/*"]}' > /tmp/evo-task-scope.json

# Run with timeout and cost controls
timeout "$MAX_DURATION" claude -p "$PROMPT" \
  --max-turns 20 \
  --output-format text \
  --dangerously-skip-permissions \
  2>&1 | tee -a "$LOG_FILE" || true

# Clean up scope file
rm -f /tmp/evo-task-scope.json

echo "[4/5] Claude Code session complete" | tee -a "$LOG_FILE"

# --- 5. Capture results ---
echo "[5/5] Capturing results..." | tee -a "$LOG_FILE"

# Count commits made
COMMIT_COUNT=$(git log --oneline main.."$BRANCH" 2>/dev/null | wc -l || echo 0)
echo "Commits: $COMMIT_COUNT" | tee -a "$LOG_FILE"

# Generate diff summary
DIFF_STAT=$(git diff --stat main.."$BRANCH" 2>/dev/null || echo "no changes")
echo "Changes: $DIFF_STAT" | tee -a "$LOG_FILE"

# Post-validation: check scope limits
FILES_CHANGED=$(git diff --name-only main.."$BRANCH" 2>/dev/null | wc -l || echo 0)
INSERTIONS=$(git diff --shortstat main.."$BRANCH" 2>/dev/null | grep -oP '\d+(?= insertion)' || echo 0)
DELETIONS=$(git diff --shortstat main.."$BRANCH" 2>/dev/null | grep -oP '\d+(?= deletion)' || echo 0)
TOTAL_LINES=$((INSERTIONS + DELETIONS))

# Check for banned files
BANNED_MODIFIED=$(git diff --name-only main.."$BRANCH" 2>/dev/null | grep -E '^(CLAUDE\.md|EVOLUTION\.md|\.env|package\.json|package-lock\.json|data/|auth_state/|\.claude/|evo-hooks/|node_modules/|docs/)' || true)

if [ -n "$BANNED_MODIFIED" ]; then
  echo "POST-VALIDATION FAILED: banned files modified: $BANNED_MODIFIED" | tee -a "$LOG_FILE"
  git checkout main && git branch -D "$BRANCH" 2>/dev/null || true
  COMMIT_COUNT=0
  NOTIFY_MSG="Evolution REJECTED: banned files modified ($BANNED_MODIFIED)"
elif [ "$FILES_CHANGED" -gt 5 ]; then
  echo "POST-VALIDATION FAILED: $FILES_CHANGED files changed (max 5)" | tee -a "$LOG_FILE"
  git checkout main && git branch -D "$BRANCH" 2>/dev/null || true
  COMMIT_COUNT=0
  NOTIFY_MSG="Evolution REJECTED: too many files ($FILES_CHANGED > 5)"
elif [ "$TOTAL_LINES" -gt 150 ]; then
  echo "POST-VALIDATION FAILED: $TOTAL_LINES lines changed (max 150)" | tee -a "$LOG_FILE"
  git checkout main && git branch -D "$BRANCH" 2>/dev/null || true
  COMMIT_COUNT=0
  NOTIFY_MSG="Evolution REJECTED: too many lines ($TOTAL_LINES > 150)"
fi

# Copy summary if Claude wrote one
if [ -f "../evolution-summary.md" ]; then
  cp "../evolution-summary.md" "data/evolution-report-$(date +%Y-%m-%d).md"
  echo "Summary written to data/evolution-report-$(date +%Y-%m-%d).md" | tee -a "$LOG_FILE"
fi

# Notify Pi (for morning briefing) — only set if not already set by post-validation failure
if [ -z "${NOTIFY_MSG:-}" ]; then
  NOTIFY_MSG="Evolution session complete. Commits: $COMMIT_COUNT, Files: $FILES_CHANGED, Lines: $TOTAL_LINES. Review: cd ~/clawdbot-evolution/clawdbot && git log --oneline main..$BRANCH"
fi

ssh -i "$HOME/.ssh/id_ed25519" "$PI_HOST" "curl -s -X POST http://localhost:3000/api/voice-status \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM' \
  -d '{\"event\":\"toast\",\"message\":\"Evolution: $COMMIT_COUNT changes proposed\"}'" 2>/dev/null || true

echo "=== Session complete $(date -Iseconds) ===" | tee -a "$LOG_FILE"
