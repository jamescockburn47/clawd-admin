# clawd-dashboard

Rust + egui native kiosk UI for the Pi touchscreen. Talks to Clawdbot over HTTP + SSE.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAWDBOT_URL` | `http://localhost:3000` | Pi Node API base URL |
| `DASHBOARD_TOKEN` | *(built-in fallback for dev)* | Bearer + SSE `token` query param — **set in production** |

Example on the Pi (systemd `Environment=` or shell before launch):

```bash
export CLAWDBOT_URL=http://localhost:3000
export DASHBOARD_TOKEN=your_token_from_.env
```

## Build (on Pi)

```bash
source ~/.cargo/env
cd ~/clawd-dashboard
cargo build --release
```

## Deploy

Copy `src/*.rs` from this repo, rebuild on the Pi, restart the dashboard process (see root `CLAUDE.md`).
