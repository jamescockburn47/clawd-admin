#!/usr/bin/env bash
# scripts/forge-ci.sh — branch-first CI for the IMPROVE stage (spec §5.3).
#
# Called by improve-deploy.ts after pushing a worktree branch to origin.
# Clones the repo fresh into a temporary directory, checks out the target
# branch, installs dependencies, runs the test suite, runs the scope check,
# and exits non-zero on any failure. All output goes to stdout for the
# caller to capture into the event log.
#
# Usage:  bash scripts/forge-ci.sh <branch-ref>
# Env:    GIT_REMOTE (default: origin)

set -euo pipefail

BRANCH="${1:-}"
if [[ -z "$BRANCH" ]]; then
  echo "forge-ci: missing branch argument" >&2
  exit 2
fi

REMOTE="${GIT_REMOTE:-origin}"
REPO_URL="$(git config --get "remote.${REMOTE}.url")"
if [[ -z "$REPO_URL" ]]; then
  echo "forge-ci: cannot find remote URL for ${REMOTE}" >&2
  exit 2
fi

CLONE_DIR="$(mktemp -d -t forge-ci-XXXXXX)"
trap 'rm -rf "$CLONE_DIR"' EXIT

echo "forge-ci: cloning ${REPO_URL} into ${CLONE_DIR}"
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$CLONE_DIR" 2>&1 || {
  echo "forge-ci: clone failed"
  exit 1
}

cd "$CLONE_DIR"

echo "forge-ci: branch = $(git rev-parse --abbrev-ref HEAD)"
echo "forge-ci: head  = $(git rev-parse HEAD)"
echo

echo "forge-ci: npm ci"
if ! npm ci --no-audit --no-fund 2>&1; then
  echo "forge-ci: npm ci failed"
  exit 1
fi

echo
echo "forge-ci: npm test"
if ! npm test 2>&1; then
  echo "forge-ci: npm test failed"
  exit 1
fi

echo
echo "forge-ci: scope check"
# Scope check: verify the diff against main doesn't touch banned files
# or exceed the tier B bounds. Mirrors src/overnight/tiering.ts.
BANNED_FILES=(
  "src/tasks/forge-orchestrator.js"
  "src/message-handler.js"
  "src/router.js"
  "src/cortex.js"
  "src/memory.js"
  "CLAUDE.md"
)
BANNED_PREFIXES=(
  "docs/superpowers/"
  "data/runtime/"
)
MAX_FILES=5
MAX_LINES=150

# Fetch main so we can diff against it
git fetch origin main --depth 50 2>&1 || {
  echo "forge-ci: failed to fetch origin/main for scope diff"
  exit 1
}

CHANGED_FILES=$(git diff --name-only origin/main...HEAD)
if [[ -z "$CHANGED_FILES" ]]; then
  echo "forge-ci: no files changed vs origin/main — this should not happen"
  exit 1
fi

FILE_COUNT=0
for f in $CHANGED_FILES; do
  FILE_COUNT=$((FILE_COUNT + 1))
  for banned in "${BANNED_FILES[@]}"; do
    if [[ "$f" == "$banned" ]]; then
      echo "forge-ci: SCOPE FAIL — banned file: $f"
      exit 1
    fi
  done
  for prefix in "${BANNED_PREFIXES[@]}"; do
    if [[ "$f" == ${prefix}* ]]; then
      echo "forge-ci: SCOPE FAIL — banned prefix: $f"
      exit 1
    fi
  done
done

if [[ "$FILE_COUNT" -gt "$MAX_FILES" ]]; then
  echo "forge-ci: SCOPE FAIL — ${FILE_COUNT} files exceeds max ${MAX_FILES}"
  exit 1
fi

LINES_CHANGED=$(git diff --shortstat origin/main...HEAD | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)
LINES_DELETED=$(git diff --shortstat origin/main...HEAD | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo 0)
TOTAL_LINES=$((LINES_CHANGED + LINES_DELETED))

if [[ "$TOTAL_LINES" -gt "$MAX_LINES" ]]; then
  echo "forge-ci: SCOPE FAIL — ${TOTAL_LINES} lines exceeds max ${MAX_LINES}"
  exit 1
fi

echo "forge-ci: scope ok — ${FILE_COUNT} files, ${TOTAL_LINES} lines"
echo
echo "forge-ci: ALL GREEN"
exit 0
