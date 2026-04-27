#!/usr/bin/env bash
# scripts/deploy-clawdbot.sh
#
# Deploy Clint (clawdbot.service) on EVO:
#   1. fetch + fast-forward pull of origin/main
#   2. restart the systemd unit
#   3. verify it came back active
#
# Runs on EVO. From Windows, invoke with:
#   ssh james@100.90.66.54 '~/clawdbot/scripts/deploy-clawdbot.sh'
#
# Prerequisites (one-time, already done as of 2026-04-19):
#   - Read-only deploy key for this repo has been added to GitHub
#     using EVO's ~/.ssh/id_ed25519.pub.
#   - git remote 'origin' is the SSH form
#     (git@github.com:jamescockburn47/clawd-admin.git).
#
# Handles WIP on EVO: tracked-file modifications are auto-stashed
# before the pull and reapplied after. Untracked files are left alone —
# if any collide with incoming commits, `git pull` fails loudly and the
# script exits non-zero with git's own message.
#
# Usage:
#   ./scripts/deploy-clawdbot.sh           # pull + restart (normal)
#   DRY_RUN=1 ./scripts/deploy-clawdbot.sh # pull only, skip restart
#   REPO_DIR=... UNIT=... override defaults

set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/james/clawdbot}"
UNIT="${UNIT:-clawdbot}"
DRY_RUN="${DRY_RUN:-0}"

cd "$REPO_DIR"

# Sanity: refuse to run if origin still points at https://github.com/
# without cached creds. That was the trap that led to this script.
remote_url=$(git remote get-url origin)
case "$remote_url" in
  git@github.com:*) ;;
  *)
    cat <<EOF >&2
WARN: origin URL is '$remote_url'. Expected SSH form.
  If 'git pull' prompts for a password or fails with "could not read
  Username", run:
    git remote set-url origin git@github.com:jamescockburn47/clawd-admin.git
EOF
    ;;
esac

# Stash tracked-file modifications so 'git pull --ff-only' can proceed.
# We deliberately do NOT stash --include-untracked: Clint writes runtime
# state files (data/overnight/events-*.jsonl etc.) while it's running;
# snapshotting those mid-write risks corruption on pop. If an untracked
# file collides with an incoming commit, git will exit with a clear
# error and the operator can resolve manually.
stashed=0
if ! git diff --quiet --ignore-submodules HEAD; then
  stash_msg="deploy-clawdbot auto-stash $(date -Iseconds)"
  echo "Stashing tracked modifications as: $stash_msg"
  git stash push -m "$stash_msg"
  stashed=1
fi

echo "Fetching origin..."
git fetch origin main

echo "Fast-forwarding main..."
git pull --ff-only origin main

if [ "$stashed" = "1" ]; then
  echo "Reapplying stash..."
  if ! git stash pop; then
    echo "ERROR: stash pop hit conflicts. WIP preserved in 'git stash list' — resolve manually with 'git stash apply' + merge." >&2
    exit 1
  fi
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY_RUN=1 — skipping systemctl restart."
  exit 0
fi

# Sync the tracked systemd unit files into /etc/systemd/system/ when they
# drift from the repo copies. Keeps every live unit in step with its
# evo-system/ source of truth.
sync_unit() {
  local src="$1" dest="$2" needs_restart_var="$3"
  if [ -f "$src" ] && ! sudo cmp -s "$src" "$dest"; then
    echo "Installing updated $dest from $src..."
    sudo cp "$src" "$dest"
    sudo systemctl daemon-reload
    eval "$needs_restart_var=1"
  fi
}

clawdbot_changed=0
llama_main_changed=0
llama_planner_changed=0
sync_unit "$REPO_DIR/evo-system/clawdbot.service" "/etc/systemd/system/${UNIT}.service" clawdbot_changed
sync_unit "$REPO_DIR/evo-system/llama-server-main.service" "/etc/systemd/system/llama-server-main.service" llama_main_changed
sync_unit "$REPO_DIR/evo-system/llama-server-planner.service" "/etc/systemd/system/llama-server-planner.service" llama_planner_changed

# Ensure the 4B planner service is enabled + active (restored 2026-04-24
# as the fast-path classifier in front of the 27B chat model).
# Idempotent: enable + start are no-ops if already in place.
if [ -f "/etc/systemd/system/llama-server-planner.service" ]; then
  if ! sudo systemctl is-enabled --quiet llama-server-planner.service 2>/dev/null; then
    echo "Enabling llama-server-planner.service..."
    sudo systemctl enable llama-server-planner.service 2>/dev/null || true
  fi
  if ! sudo systemctl is-active --quiet llama-server-planner.service 2>/dev/null; then
    echo "Starting llama-server-planner.service..."
    sudo systemctl start llama-server-planner.service || true
  elif [ "$llama_planner_changed" = "1" ]; then
    echo "Restarting llama-server-planner.service (new unit)..."
    sudo systemctl restart llama-server-planner.service || true
  fi
fi

# Retire services that are no longer referenced in evo-system/. Idempotent:
# only fires when the live unit is present (so a fresh EVO with no legacy
# state is a no-op). Preserves unit files under /etc/systemd/system/ so
# operators can inspect them — `disable` removes the WantedBy symlinks,
# `stop` terminates the running instance, unit file stays in place.
retire_unit() {
  local unit="$1"
  if sudo systemctl list-unit-files "$unit" --no-legend --no-pager 2>/dev/null | grep -q .; then
    if sudo systemctl is-active --quiet "$unit" 2>/dev/null; then
      echo "Retiring $unit (stop + disable)..."
      sudo systemctl stop "$unit" || true
    fi
    if sudo systemctl is-enabled --quiet "$unit" 2>/dev/null; then
      sudo systemctl disable "$unit" || true
    fi
  fi
}
for legacy in \
    llama-server-classifier.service \
    llama-server-coder.service \
    llama-swap-main.service llama-swap-main.timer \
    llama-swap-coder.service llama-swap-coder.timer; do
  retire_unit "$legacy"
done

# If the llama-server-main unit changed, restart it so the new binary/args
# take effect. Rolls the Qwen3.6-27B loader (~45 s startup) before Clint
# tries to talk to it on restart.
if [ "$llama_main_changed" = "1" ]; then
  echo "Restarting llama-server-main.service (new unit)..."
  sudo systemctl restart llama-server-main.service || true
  sleep 3
  if ! sudo systemctl is-active --quiet llama-server-main.service; then
    echo "WARN: llama-server-main.service not active after restart — check journalctl -u llama-server-main.service" >&2
  fi
fi

# Pre-flight: surface any non-systemd process holding :3000. The unit's
# ExecStartPre reclaims the port automatically, but we want operators to
# see when that happens so the source of the orphan can be diagnosed.
# Orphans typically arise when something starts the bot via `nohup node ...`
# over SSH — the tsx process is reparented to init after the SSH session
# closes and outlives any systemctl-driven restart.
port_pid=$(sudo ss -tlnpH sport = :3000 2>/dev/null | awk -F 'pid=' 'NR==1 {split($2, a, ","); print a[1]}')
if [ -n "${port_pid:-}" ] && [ -r "/proc/$port_pid/cgroup" ]; then
  cg=$(awk 'NR==1' "/proc/$port_pid/cgroup" 2>/dev/null || true)
  case "$cg" in
    *"system.slice/${UNIT}.service"*) ;;  # expected: systemd-managed
    *)
      cmd=$(tr '\0' ' ' < "/proc/$port_pid/cmdline" 2>/dev/null || true)
      etime=$(ps -p "$port_pid" -o etime= 2>/dev/null | tr -d ' ' || true)
      cat <<EOF >&2
WARN: non-systemd process holds :3000 before restart — will be reclaimed
  by ExecStartPre. Investigate how it started (see feedback_no_nohup_for_clawdbot.md).
    pid:    $port_pid
    etime:  ${etime:-unknown}
    cmd:    ${cmd:-<unreadable>}
    cgroup: $cg
EOF
      ;;
  esac
fi

echo "Restarting $UNIT..."
sudo systemctl restart "$UNIT"
sleep 3

if systemctl is-active --quiet "$UNIT"; then
  echo "OK: $UNIT active."
  # Show the last few log lines as a smoke test.
  sudo journalctl -u "$UNIT" -n 5 --no-pager | tail -5
else
  echo "ERROR: $UNIT is not active after restart." >&2
  sudo journalctl -u "$UNIT" -n 30 --no-pager >&2
  exit 1
fi

echo "Refreshing system knowledge..."
if node --env-file=.env --input-type=module -e "const m = await import('./src/system-knowledge.js'); const r = await m.refreshSystemKnowledge(); if (!r.refreshed) { console.error(JSON.stringify(r)); process.exit(1); } console.log(JSON.stringify(r));"; then
  echo "OK: system knowledge refreshed."
else
  echo "ERROR: system knowledge refresh failed after deploy." >&2
  exit 1
fi
