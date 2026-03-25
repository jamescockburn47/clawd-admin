# Fast deploy: Node only + restart (no cargo). Logs to deploy-pi-node.log in repo root.
$ROOT = Split-Path $PSScriptRoot -Parent
$log = Join-Path $ROOT "deploy-pi-node.log"
$KEY = "C:/Users/James/.ssh/id_ed25519"
$PI = "pi@192.168.1.211"
$sshArgs = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=25", "-i", $KEY, $PI)
$scpBase = @("-o", "ConnectTimeout=25", "-i", $KEY)

function Log($m) { $m | Tee-Object -FilePath $log -Append }

"=== $(Get-Date -Format o) ===" | Out-File $log -Encoding utf8
try {
  Log "SSH test..."
  ssh @sshArgs "echo PI_OK; hostname" 2>&1 | Tee-Object -FilePath $log -Append
  Log "SCP..."
  scp @scpBase "$ROOT/src/scheduler.js","$ROOT/src/config.js","$ROOT/src/memory.js","$ROOT/src/index.js","$ROOT/src/router.js","$ROOT/src/system-knowledge.js","$ROOT/version.json" "${PI}:~/clawdbot/" 2>&1 | Tee-Object -FilePath $log -Append
  scp @scpBase "$ROOT/src/tools/handler.js" "${PI}:~/clawdbot/src/tools/handler.js" 2>&1 | Tee-Object -FilePath $log -Append
  Log "rm ollama.js..."
  ssh @sshArgs "rm -f ~/clawdbot/src/ollama.js; echo RM_OK" 2>&1 | Tee-Object -FilePath $log -Append
  Log "restart..."
  ssh @sshArgs "sudo systemctl restart clawdbot && sleep 2 && systemctl is-active clawdbot" 2>&1 | Tee-Object -FilePath $log -Append
  Log "DONE"
} catch {
  $_ | Tee-Object -FilePath $log -Append
  exit 1
}
