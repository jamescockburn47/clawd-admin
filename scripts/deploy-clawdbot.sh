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

# Sync the tracked systemd unit file into /etc/systemd/system/ if it drifted
# from the repo copy. Keeps the live unit (which includes the ExecStartPre
# port-3000 reclaim) in step with evo-system/clawdbot.service.
tracked_unit="$REPO_DIR/evo-system/clawdbot.service"
live_unit="/etc/systemd/system/${UNIT}.service"
if [ -f "$tracked_unit" ] && ! sudo cmp -s "$tracked_unit" "$live_unit"; then
  echo "Installing updated $live_unit from $tracked_unit..."
  sudo cp "$tracked_unit" "$live_unit"
  sudo systemctl daemon-reload
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
