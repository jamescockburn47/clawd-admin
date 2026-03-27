#!/usr/bin/env bash
# evo-hooks/scope-guard.sh — PreToolUse hook for evolution tasks
# Blocks edits/writes/bash-writes to files not in the task scope.
# Reads allowed files from /tmp/evo-task-scope.json
# Exit 0 = allow, Exit 2 = block (Claude Code cancels the action)

set -euo pipefail

SCOPE_FILE="/tmp/evo-task-scope.json"

# If no scope file, block everything (safety default)
if [ ! -f "$SCOPE_FILE" ]; then
  echo "BLOCKED: No scope file found at $SCOPE_FILE. Cannot proceed." >&2
  exit 2
fi

# Read the hook input from stdin
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // empty')

# --- Edit / Write / MultiEdit: check file_path ---
if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "MultiEdit" ]]; then
  FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty')

  if [ -z "$FILE_PATH" ]; then
    echo "BLOCKED: No file_path in $TOOL_NAME call." >&2
    exit 2
  fi

  # Normalise to relative path
  FILE_PATH="${FILE_PATH#/home/james/clawdbot-claude-code/}"

  # Check against allowed files
  ALLOWED=$(jq -r --arg f "$FILE_PATH" '.allowed_files[] | select(. == $f)' "$SCOPE_FILE")

  if [ -z "$ALLOWED" ]; then
    echo "BLOCKED: $FILE_PATH is not in the task scope. Allowed files: $(jq -r '.allowed_files | join(", ")' "$SCOPE_FILE")" >&2
    exit 2
  fi

  exit 0
fi

# --- Bash: block file-mutating commands targeting banned files/dirs ---
if [[ "$TOOL_NAME" == "Bash" ]]; then
  COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // empty')

  # Block commands that write to files
  DANGEROUS_PATTERNS="sed -i|> |>> |tee |mv |cp |rm "

  if echo "$COMMAND" | grep -qE "$DANGEROUS_PATTERNS"; then
    # Hard-banned files — never writable regardless of scope
    BANNED_FILES=("CLAUDE.md" "EVOLUTION.md" ".env" "package.json" "package-lock.json")

    for BANNED in "${BANNED_FILES[@]}"; do
      if echo "$COMMAND" | grep -q "$BANNED"; then
        echo "BLOCKED: Bash command targets banned file: $BANNED" >&2
        exit 2
      fi
    done

    # Block writes to protected directories
    if echo "$COMMAND" | grep -qE "data/|auth_state/|node_modules/|\.claude/"; then
      echo "BLOCKED: Bash command targets protected directory" >&2
      exit 2
    fi
  fi

  # Allow read-only bash commands (ls, cat, grep, git diff, node --check, etc.)
  exit 0
fi

# All other tools (Read, Grep, Glob, etc.) — allow
exit 0
