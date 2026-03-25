# Full deploy per .cursorrules — Pi Node + Rust dashboard + EVO memory/voice (via Pi hop).
# Run: powershell -ExecutionPolicy Bypass -File .\scripts\deploy-all.ps1
param(
  [switch]$SkipDashboard,
  [switch]$SkipEvo
)

$ErrorActionPreference = "Stop"
$KEY = "C:/Users/James/.ssh/id_ed25519"
$PI = "pi@192.168.1.211"
$EVO = "james@192.168.1.230"
$ROOT = Split-Path $PSScriptRoot -Parent
$LOG = Join-Path $ROOT "deploy-all.log"

function W($m) { Write-Host $m; Add-Content -Path $LOG -Value $m }

"=== deploy-all $(Get-Date -Format o) ===" | Out-File $LOG -Encoding utf8
W "ROOT=$ROOT"

$sshPi = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=25", "-i", $KEY, $PI)
$scp = @("-o", "ConnectTimeout=25", "-i", $KEY)

W "== SSH Pi =="
& ssh @sshPi "echo PI_OK; hostname" 2>&1 | Tee-Object -FilePath $LOG -Append

W "== SCP Node =="
& scp @scp @(
  "$ROOT/src/scheduler.js",
  "$ROOT/src/config.js",
  "$ROOT/src/memory.js",
  "$ROOT/src/index.js",
  "$ROOT/src/router.js",
  "$ROOT/src/system-knowledge.js",
  "$ROOT/version.json",
  "${PI}:~/clawdbot/"
) 2>&1 | Tee-Object -FilePath $LOG -Append

& scp @scp "$ROOT/src/tools/handler.js" "${PI}:~/clawdbot/src/tools/handler.js" 2>&1 | Tee-Object -FilePath $LOG -Append

W "== rm ollama.js =="
& ssh @sshPi "rm -f ~/clawdbot/src/ollama.js; echo RM_OK" 2>&1 | Tee-Object -FilePath $LOG -Append

W "== systemctl restart clawdbot =="
& ssh @sshPi "sudo systemctl restart clawdbot && sleep 2 && systemctl is-active clawdbot" 2>&1 | Tee-Object -FilePath $LOG -Append

W "== journalctl clawdbot (last 12) =="
& ssh @sshPi "journalctl -u clawdbot --no-pager -n 12" 2>&1 | Tee-Object -FilePath $LOG -Append

if (-not $SkipDashboard) {
  W "== SCP dashboard (api.rs + main.rs) =="
  & scp @scp "$ROOT/clawd-dashboard/src/api.rs" "$ROOT/clawd-dashboard/src/main.rs" "${PI}:~/clawd-dashboard/src/" 2>&1 | Tee-Object -FilePath $LOG -Append

  W "== cargo build --release (Pi; may take several minutes) =="
  & ssh @sshPi "bash -lc 'source ~/.cargo/env; cd ~/clawd-dashboard && cargo build --release'" 2>&1 | Tee-Object -FilePath $LOG -Append

  W "== relaunch clawd-dashboard =="
  & ssh @sshPi "pkill clawd-dashboard 2>/dev/null; sleep 2; export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0; nohup /home/pi/clawd-dashboard/target/release/clawd-dashboard > /tmp/clawd-dashboard.log 2>&1 & sleep 2; tail -8 /tmp/clawd-dashboard.log" 2>&1 | Tee-Object -FilePath $LOG -Append
}

if (-not $SkipEvo) {
  W "== Stage EVO files on Pi /tmp =="
  & scp @scp "$ROOT/memory-service/main.py" "$ROOT/memory-service/command_router.py" "${PI}:/tmp/" 2>&1 | Tee-Object -FilePath $LOG -Append
  & scp @scp "$ROOT/evo-voice/voice_listener.py" "$ROOT/evo-voice/clawdbot-voice.service" "${PI}:/tmp/" 2>&1 | Tee-Object -FilePath $LOG -Append

  W "== Pi -> EVO scp + restart memory + voice =="
  $remote = @"
set -e
scp -o BatchMode=yes -o ConnectTimeout=20 /tmp/main.py /tmp/command_router.py ${EVO}:~/clawdbot-memory/
scp -o BatchMode=yes -o ConnectTimeout=20 /tmp/voice_listener.py /tmp/clawdbot-voice.service ${EVO}:~/clawdbot-memory/
ssh -o BatchMode=yes -o ConnectTimeout=20 ${EVO} 'sudo cp ~/clawdbot-memory/clawdbot-voice.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart clawdbot-memory && sudo systemctl restart clawdbot-voice && echo EVO_RESTART_OK'
ssh -o BatchMode=yes -o ConnectTimeout=20 ${EVO} 'journalctl -u clawdbot-voice --no-pager -n 8'
"@
  & ssh @sshPi $remote 2>&1 | Tee-Object -FilePath $LOG -Append
}

W "=== DONE $(Get-Date -Format o) ==="
W "Log: $LOG"
