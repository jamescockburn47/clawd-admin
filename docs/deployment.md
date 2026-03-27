# Deployment & Operations Reference

## Deploy Node.js (clawdbot backend) to Pi

```bash
scp -i C:/Users/James/.ssh/id_ed25519 <local_file> pi@192.168.1.211:~/clawdbot/<remote_path>
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "sudo systemctl restart clawdbot"
```

## Deploy Dashboard (Rust) to Pi

```bash
# 1. Copy source to Pi dashboard project
scp -i C:/Users/James/.ssh/id_ed25519 clawd-dashboard/src/main.rs pi@192.168.1.211:~/clawd-dashboard/src/main.rs
# 2. Build on Pi (cargo must be sourced)
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "source ~/.cargo/env; cd ~/clawd-dashboard && cargo build --release"
# 3. Relaunch dashboard
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "pkill clawd-dashboard 2>/dev/null; sleep 2; export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0; nohup /home/pi/clawd-dashboard/target/release/clawd-dashboard > /tmp/clawd-dashboard.log 2>&1 &"
```

## Deploy Voice Listener to EVO X2 (via Pi SSH hop)

```bash
# 1. Copy to Pi as staging
scp -i C:/Users/James/.ssh/id_ed25519 evo-voice/voice_listener.py pi@192.168.1.211:/tmp/voice_listener.py
# 2. Hop from Pi to EVO
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "scp /tmp/voice_listener.py james@192.168.1.230:~/clawdbot-memory/voice_listener.py"
# 3. Restart voice service on EVO
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ssh james@192.168.1.230 'sudo systemctl restart clawdbot-voice'"
```

## Take a Screenshot of the Pi Display

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0; grim /tmp/screenshot.png"
scp -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211:/tmp/screenshot.png <local_path>
```

## Check Logs

```bash
# Pi clawdbot
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "journalctl -u clawdbot --no-pager -n 50"
# Pi dashboard
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "tail -50 /tmp/clawd-dashboard.log"
# EVO voice listener
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ssh james@192.168.1.230 'journalctl -u clawdbot-voice -n 50 --no-pager'"
# EVO llama-server main
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ssh james@10.0.0.2 'journalctl -u llama-server-main -n 50 --no-pager'"
# EVO llama-server classifier
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ssh james@10.0.0.2 'journalctl -u llama-server-classifier -n 50 --no-pager'"
```

## systemd Services

### Pi

```ini
# /etc/systemd/system/clawdbot.service
[Unit]
Description=Clawdbot WhatsApp Admin Assistant
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/clawdbot
ExecStart=/usr/bin/node --env-file=.env src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### EVO X2

See `docs/evo-x2-reference.md` for full service/port/model table.

```
llama-server-main.service      — port 8080, VL-30B (day) / Coder-30B (night)
llama-server-classifier.service — port 8081, Qwen3-0.6B
llama-server-tts.service       — port 8082, Orpheus-3B (running but unused)
llama-server-embed.service     — port 8083, nomic-embed-text (always on)
llama-server-docling.service   — port 8084, Granite-Docling-258M
clawdbot-memory                — port 5100, FastAPI memory service
clawdbot-voice.service         — voice_listener.py
SearXNG (Docker)               — port 8888, web search

llama-swap-coder.timer         — 22:00, swap to coder model
llama-swap-main.timer          — 06:00, swap to VL model
llama-sleep.timer              — DISABLED
llama-wake.timer               — DISABLED
```

## SSH Patterns

- **SSH key**: `C:\Users\James\.ssh\id_ed25519`
- **Pi**: `ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "command"`
- **EVO from Pi**: `ssh james@10.0.0.2 'command'` (direct ethernet, host key in known_hosts)
- **SCP**: `scp -i C:/Users/James/.ssh/id_ed25519 <local_file> pi@192.168.1.211:~/clawdbot/<remote_path>`
- **SCP doesn't merge** — it overwrites. Send individual files when possible.
