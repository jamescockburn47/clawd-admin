# clawd-dashboard

Rust + egui native kiosk UI for the Pi touchscreen. Talks to Clawdbot over HTTP + SSE.

## Environment variables

- `CLAWDBOT_URL`: defaults to `http://localhost:3000`. On the real Pi this should point at the EVO host, not the Pi itself.
- `DASHBOARD_TOKEN`: defaults to the invalid placeholder `dev-token-change-me`. Set a real token in production for Bearer auth and the SSE `token` query param, including `/api/status`.

Example on the Pi (systemd `Environment=` or shell before launch):

```bash
export CLAWDBOT_URL=http://10.0.0.2:3000
export DASHBOARD_TOKEN=your_token_from_.env
```

## Build (on Pi)

```bash
source ~/.cargo/env
cd ~/clawd-dashboard
cargo build --release
```

## Deploy

Copy `src/*.rs` from this repo, rebuild on the Pi, restart the dashboard process, and make sure `CLAWDBOT_URL` still targets the EVO bot API plus the correct `DASHBOARD_TOKEN`.
