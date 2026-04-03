# The Forge — No Separate Service Required

The Forge runs inside clawdbot's scheduler at 22:30 London time.
No separate systemd timer needed — the scheduler calls checkForge() every minute
and it activates at 22:30.

To disable the old overnight coder:
  sudo systemctl disable overnight-coder.timer
  sudo systemctl stop overnight-coder.timer

The evo-evolve.timer (22:05) should also be disabled:
  sudo systemctl disable evo-evolve.timer
  sudo systemctl stop evo-evolve.timer

Both are replaced by the Forge orchestrator in src/tasks/forge-orchestrator.js.
