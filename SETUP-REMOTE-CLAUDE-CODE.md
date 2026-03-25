# Remote Claude Code CLI Setup — EVO X2 + Pi

Run Claude Code directly on EVO X2, deploy to Pi over direct ethernet, access from anywhere via Tailscale.

## 1. Install Tailscale on EVO X2 (Linux)

```bash
# SSH into EVO from Pi (or local network)
ssh james@10.0.0.2

# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

# Authenticate (will give you a URL to paste into a browser)
sudo tailscale up

# Verify
tailscale status
# Should show nucbox-evo-x2 as online

# Optional: set it to start on boot (systemd)
sudo systemctl enable tailscaled
```

## 2. Install Tailscale on Pi

```bash
ssh pi@192.168.1.211

curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

sudo systemctl enable tailscaled
```

## 3. Install Claude Code CLI on EVO X2

```bash
ssh james@10.0.0.2

# Option A: Native installer (recommended, auto-updates)
curl -fsSL https://claude.ai/install.sh | sh

# Option B: npm (if native installer has issues)
npm install -g @anthropic-ai/claude-code

# Verify
claude --version
```

## 4. Authenticate Claude Code on EVO

```bash
# Option A: API key (simplest for headless — no browser needed)
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
source ~/.bashrc
claude  # should work immediately

# Option B: Browser OAuth (if EVO has desktop/display)
claude  # follow the URL prompt, paste into browser
```

## 5. Set up project access on EVO

The clawdbot Node.js code lives on Pi. Two options:

### Option A: Clone repo on EVO (recommended)
```bash
# On EVO
cd ~
git clone <your-repo-url> clawdbot-claude-code

# Create CLAUDE.md symlink or copy so Claude Code has full context
# The repo already has CLAUDE.md checked in
```

### Option B: Mount Pi filesystem via SSHFS
```bash
# On EVO — mount Pi's clawdbot dir
sudo apt install sshfs
mkdir -p ~/pi-clawdbot
sshfs pi@10.0.0.1:/home/pi/clawdbot ~/pi-clawdbot

# Add to /etc/fstab for persistence:
# pi@10.0.0.1:/home/pi/clawdbot /home/james/pi-clawdbot fuse.sshfs _netdev,user,idmap=user,allow_other,reconnect 0 0
```

## 6. Deploy workflow from EVO

### Deploy Node.js to Pi (from EVO, direct ethernet)
```bash
# Single file
scp src/trigger.js pi@10.0.0.1:~/clawdbot/src/trigger.js
ssh pi@10.0.0.1 "sudo systemctl restart clawdbot"

# Or if using git: push from EVO, pull on Pi
ssh pi@10.0.0.1 "cd ~/clawdbot && git pull && sudo systemctl restart clawdbot"
```

### EVO code (memory service, voice listener) — edit in place
```bash
# No deploy needed — Claude Code edits files directly on EVO
# Just restart the relevant service
sudo systemctl restart clawdbot-memory
sudo systemctl restart clawdbot-voice
```

## 7. Remote access from anywhere

```bash
# From any machine with Tailscale:
ssh james@nucbox-evo-x2    # Tailscale hostname
# or
ssh james@100.110.87.14    # Tailscale IP (will change once re-registered)

# Then run Claude Code
cd ~/clawdbot-claude-code
claude
```

### tmux for persistent sessions
```bash
# On EVO — start a persistent Claude Code session
tmux new -s claude

# Inside tmux
cd ~/clawdbot-claude-code
claude

# Detach: Ctrl+B, D
# Reattach from anywhere: ssh into EVO then
tmux attach -t claude
```

## 8. CLAUDE.md for EVO environment

When running Claude Code on EVO, update the Quick Reference to reflect local paths:

| Key | Value (EVO) |
|-----|-------------|
| **Project path** | `~/clawdbot-claude-code` |
| **Pi deploy** | `scp <file> pi@10.0.0.1:~/clawdbot/<path>` |
| **Pi restart** | `ssh pi@10.0.0.1 "sudo systemctl restart clawdbot"` |
| **Pi SSH** | `ssh pi@10.0.0.1` (direct ethernet, 0.4ms) |
| **EVO services** | Edit in place, `sudo systemctl restart <service>` |
| **Memory service** | `~/clawdbot-memory/` (local) |
| **Voice listener** | `~/clawdbot-memory/voice_listener.py` (local) |

## Checklist

- [ ] Tailscale installed + authenticated on EVO
- [ ] Tailscale installed + authenticated on Pi
- [ ] Verify Tailscale connectivity: `tailscale ping nucbox-evo-x2` from Windows
- [ ] Claude Code installed on EVO
- [ ] Claude Code authenticated (API key or OAuth)
- [ ] Clawdbot repo cloned/accessible on EVO
- [ ] Test deploy: edit file on EVO → scp to Pi → restart → verify
- [ ] tmux set up for persistent sessions
- [ ] Remove old Windows Tailscale node if conflicting (`tailscale admin` dashboard)
