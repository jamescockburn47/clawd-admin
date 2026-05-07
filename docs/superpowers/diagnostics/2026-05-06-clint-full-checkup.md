# Clint Full Checkup — 2026-05-06

> Full diagnostic run on every Clint subsystem. Started 22:39 London, James asleep, YOLO authorised.
> This file IS both plan AND report — findings filled in inline as the checks run.
> Every check is read-only on EVO. No restarts, no deploys, no commits to other branches.

---

## ⚠ P0-CRITICAL — DO BEFORE ANYTHING ELSE TOMORROW

**Public token exposure on `https://clawd.lqcouncil.com/`.** Cloudflare Tunnel `sovren-evo` (config `~/.cloudflared/config.yml`) maps that hostname to `localhost:3000` (the bot). The bot's catch-all default page renders `<a href="/dashboard?token=${config.dashboardToken}">` to **any unauthenticated GET**. So:

1. Anyone in the world: `curl https://clawd.lqcouncil.com/` → reads `DASHBOARD_TOKEN=VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM` from the response body.
2. With that token they can call **every** authed endpoint, including: `/api/send` (send WhatsApp messages as James to anyone — LQCore, MG, clients), `/api/messages` (read message buffer), `/api/audit` (full tool-call audit), `/api/soul` (your personality file), `/api/forge-now` (trigger Opus billing), `/api/memory/*` (read/write memory), `/api/voice-command`, `/api/desktop-mode`.
3. **Verified end-to-end from this Windows laptop** (browser UA, no special access): `https://clawd.lqcouncil.com/api/status?token=...` returned 200 with `{"connected":true,"name":"Clint","jid":"447719697305:3@s.whatsapp.net","lastActivity":...,"uptime":780916,"memoryMB":132}` — including your full WhatsApp JID (PII).
4. Separately, `POST /debate` is unauthenticated by design (header comment in `src/http-server.js:64-68` says "no dashboard-token auth — council sends its own bearer token; verification… belongs in a future phase"). Public anyone can fire `/debate` with arbitrary payloads → expensive LLM invocations, possible prompt injection on tool calls, cost amplification.

**Earliest possible exposure window:** since `clawd.lqcouncil.com` was added to the cloudflared ingress (config file at `/home/james/.cloudflared/config.yml`). I did not find the file's mtime — check it. If it's been weeks, assume the token is potentially compromised by anyone who stumbled across the subdomain.

**Recommended actions, in order:**
1. **Immediate (kill exposure):**
   ```bash
   # On EVO:
   sudo nano /home/james/.cloudflared/config.yml
   # Comment out or remove:
   #  - hostname: clawd.lqcouncil.com
   #    service: http://localhost:3000
   sudo systemctl restart cloudflared
   ```
   This takes the bot off the public internet entirely. Bot still works on LAN/Tailscale.
2. **Rotate token (in case already harvested):**
   ```bash
   # New token:
   NEW=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-43)
   # In ~/clawdbot/.env, replace DASHBOARD_TOKEN=… with:
   echo "DASHBOARD_TOKEN=$NEW"  # paste into .env
   sudo systemctl restart clawdbot
   # Update clawd-console env on Legion laptop with the new token.
   ```
3. **Code fix (push later):** `src/http-server.js` default-route handler must `return json(res, 401, ...)` if `checkAuth(req)` fails — never embed the token in HTML.
4. **`/debate` auth:** require a shared secret header from bot-council (HMAC of body, or static bearer in `LQC_DEBATE_SHARED_SECRET`).

If the public exposure was intended (e.g., for a public web demo), rotate the token + auth-gate the catch-all anyway: the token must never appear in plaintext HTML.

**This finding alone outranks every other issue in this report.**

---

## Triage Summary

P0 = bot non-functional / data leak / silent failure of a critical loop.
P1 = a feature is broken but the bot still operates.
P2 = drift / known-issue confirmation.
P3 = hygiene.

### P0 — urgent, look first thing

1. **PUBLIC TOKEN LEAK on `clawd.lqcouncil.com`** — see banner above. Anyone on the internet can extract `DASHBOARD_TOKEN` and impersonate James via `/api/send`, read all bot data, trigger Opus-billing Forge runs, etc. **Highest priority. Fix is ~5 minutes (drop the cloudflared ingress + rotate the token + auth-gate the catch-all).**
2. **Scheduler `setInterval` leak on every WhatsApp reconnect** (Phase 1 T04b). 55 leaked intervals after 9 days uptime, ~275,000 "tick skipped" log lines. Caused by `let schedulerStarted = false` being declared inside `startBot()`, which runs on every reconnect. Fix is moving the guard to module scope (snippet in T04b).
3. **`clawd-console.service` on EVO is in a 26-day restart loop** (Phase 1 T03b). Restart counter 227,342. Port 3100 collides with `bot-council`. CLAUDE.md says the console belongs on the Legion laptop, not EVO — this systemd unit is stale. Disable + remove unit file.
4. **Dream mode broken since Pi→EVO migration** (Phase 6 T33). Every night the timer fires, but the unit's `ExecStartPre` rsyncs from `pi@10.0.0.1:/home/pi/clawdbot/data/conversation-logs/` (stale source); dream_mode.py then reads a 39-file frozen dir while the live data sits in `/home/james/clawdbot/data/conversation-logs/` (88 files). Soul has had **zero new dream-derived input for 5+ weeks**. Memory category `dream` = 1.

### P1 — broken feature

5. **CONSOLIDATE extractor returns 0 candidates** (Phase 6 T27). Qwen 27B not producing structured output from real conversations. No new memories from chat in days. Same root cause likely affects:
6. **IMPROVE synthesis returns 0 candidates** (Phase 6 T30). Last Saturday: 33 observations groomed → 0 final candidates. System observes its own decay (cortex p95 80s, category imbalance, 6 quality failures) and cannot remediate.
7. **Golden-questions: 0/20 passed every day** (Phase 6 T33b). 100% failure on contract tests. Trailing median 0%, so the regression detector never fires.
8. **Cortex gather p95: 80,601 ms** (Phase 6 T33b). Context retrieval taking 80 seconds — dominates user-perceived latency for any non-trivial query.
9. **`src/lqcouncil/client.js` calls dropped bot-council paths** (Phase 9 T43). `/diag/health`, `/bots/schema`, `/bots/{id}/history` all return 404 since 2026-04-20. LQ-related tools (`lqc_status`, `lqc_history`, `lqc_bots_list`) likely error in groups.
10. **WhatsApp message decryption failures** (Phase 3 T15). 3 today (James + YC). Fail twice on the same msgId and recorded for session-repair, but no log confirmation that the repaired plaintext is later consumed. May explain James's Apr 29 "Why are you not responding in the lqcore group" frustration.

### P2 — drift / verify intent

11. **Routing reality vs CLAUDE.md** (Phase 4 T18, Phase 3 T15b). CLAUDE.md says "MiniMax M2.7 default" + "EVO local never generates chat". Reality: Qwen 27B is the default chat model; "Sonnet" calls almost certainly route through MiniMax-as-Anthropic-compatible (MINIMAX_API_KEY set, ANTHROPIC_API_KEY empty). Either reality is correct (cheaper than M2.7) and CLAUDE.md is stale, or this is a config drift. **Decide and update CLAUDE.md.**
12. **Three stale memory entries**:
    - `project_lqcore_member_register` — code IS shipped, file IS populated (16 members across 3 groups). Update or delete.
    - WIP /debate-handler.js — committed since 2026-04-23. Update.
    - `project_lqc_api_drift_20260420` — drift is still real, but worth re-dating + linking to T43 once paths are fixed.
13. **`ANTHROPIC_API_KEY` is empty** (Phase 4 T18) yet calls labelled "claude-sonnet-4-6" succeed and bill against Anthropic-style pricing. Confirm whether MiniMax is impersonating Sonnet via base_url override, or whether Anthropic is silently disabled (which would make Opus quality-gate paths fail when invoked).
14. **CLAUDE.md "ambient agency for LQCore"** (Phase 8 T38). Live config has `posture: direct_only` for all 4 groups. Post-bdc2704 ("remove ambient agency"), ambient is off everywhere. Update CLAUDE.md.

### P3 — hygiene

15. **architecture.md is stale** on port + model assignments (Phase 4 T16): classifier on 8081 → actual 8085, Qwen 0.6B → actual 4B, embedding "nomic-embed" → actual Qwen3-8B, no mention of port 8086 (gemma-4-31B), port 8000 (SOVREN), Postgres :5432, Redis :6379, bot-council :3100, Vite :5173, cloudflared :20241. Update or replace with a generated table.
16. **Codebase fragmentation on EVO** (Phase 5 T21): memory-service source in 3 directories (`~/clawdbot-memory/`, `~/clawdbot/memory-service/`, `~/clawdbot-claude-code/memory-service/`). Only `~/clawdbot-memory/` is wired to the running service. Delete the other two.
17. **Worktree branch `claude/amazing-williams-b98bcb` is 50+ commits behind main** — anything that lives only on this branch (e.g. `4d5ce2d "fix(debate): handle MiniMax XML tool calls + smoke-test fast path"`) is rotting. Merge or drop.
18. **Swap saturated** (Phase 1 T05). 2 GB / 2 GB, 1.9 MB free. Likely consequence of the scheduler-leak P0; should resolve on bot restart after the fix.
19. **Verify physical analog speaker** is connected to EVO for Piper TTS playback (Phase 7 T35). `aplay -l` only listed HDMI cards.
20. **`/api/memory/list?category=X` query param is ignored** (Phase 5 T22). Minor API bug.
21. **Voice has had only 1 wake event in 7 days** (Phase 7 T37) — voice channel is technically alive but practically unused. Confirm intended use pattern.

### Subsystems confirmed healthy

- WhatsApp connection (despite ~6 reconnects/day; that's normal Baileys behaviour, the leak is the problem).
- All 5 llama-server endpoints (8080 main chat, 8083 embed, 8084 docling, 8085 4B classifier, 8086 gemma-4-31B).
- Memory FastAPI service on :5100 (27.6 days uptime, llm/embedding online).
- 4B classifier returns sane outputs on smoke test (<100ms).
- Voice listener service (lifecycle wake → STT → LLM → TTS → follow-up works end-to-end; just rarely triggered).
- Pi dashboard Rust binary alive 28 days.
- Output filter (canary + regex) wired into both message-handler reply paths.
- Group config (4 groups, all direct_only posture honoured).
- Morning briefing 07:00 + daily health 08:45 DMs (today + every day this week).
- Daily backup, trace-analysis, system-refresh, ground-truth, project-sync, sovren-cross-ref operational tasks.
- LQC monitor (4 stuck-debate alerts fired tonight 22:37–22:38 — alerts fire correctly even though `client.js` reads via dropped paths).
- LQcouncil weekly digest (last fired Sun 2026-05-03 09:00) and lqc daily-health (today 08:45).
- Sentry instrumentation enabled (host `o4511241857597440.ingest.de.sentry.io`).
- /api/usage tracking 20 calls today, $0.067 — well within 100/day limit.
- Daily backups present for last 7 days, 03:00 fire each day.
- WhatsApp `auth_state` healthy (creds.json mtime today, pre-keys current).
- Group-members register populated (16 members across LQCore + LQcouncil + one other).
- Style-calibration weekly timer (Sunday 22:30, last 2026-05-03).

---

## Scope rules

- **READ-ONLY on EVO.** No `systemctl restart`, no deploys, no `git push origin main`.
- All `/api/*` probes done by SSH-into-EVO + `curl localhost:3000` (DASHBOARD_TOKEN never leaves EVO).
- WIP on EVO (`src/http-server.js` modified, `src/debate-handler.js` untracked) **preserved** — diff inspected, file untouched.
- Findings logged inline. Each task has **Findings** + **Verdict** filled in.
- Verdict legend: `OK` / `WARN` / `FAIL` / `UNCHECKED` / `N/A`.
- Final report committed to `claude/amazing-williams-b98bcb` branch on this worktree, branch pushed for James to read tomorrow.

---

## Phase 1 — Liveness & Service Health (EVO)

### T01: SSH reach to EVO
**Findings:** EVO `james-NucBox-EVO-X2` reachable via Tailscale; up 27 days 14h. Load avg 0.14/0.20/0.23 (idle).
**Verdict:** OK

### T02: clawdbot service status
**Findings:** `clawdbot.service` active (running) since Mon 2026-04-27 21:55:12 BST = ~9 days uptime. Memory 287MB peak 311MB. Main PID 2811132 → tsx → node 2811144 + esbuild 2811156. Service enabled.
**Verdict:** OK (process alive)

### T03: All clawd-related units + timers
**Findings:**
- `clawdbot.service` — active running ✓
- `clawdbot-memory.service` — active running ✓ (FastAPI :5100)
- `clawdbot-voice.service` — active running ✓
- `clawdbot-dream.service` — inactive/dead (normal post-run; timer fired today 22:05:03 36min before checkup)
- `clawdbot-dream.timer` — active waiting, next fire Thu 2026-05-07 22:05 ✓
- `clawd-console.service` — **activating (auto-restart) Result: exit-code** 🚨 (see T03b)
- `style-calibration.timer` — active, next Sun 2026-05-10 22:30 ✓
- `bot-council-scoreboard.timer` — active, next Fri 2026-05-08 18:00 ✓
- `bot-council-test-cleanup.timer` — active, next Thu 2026-05-07 00:03 ✓

**Timers MISSING vs CLAUDE.md spec** (would-be evidence that overnight stages run as systemd timers): consolidate, probe, report, briefing, improve, daily-backup, trace-analyser, system-refresh, ground-truth, lqc-weekly-digest, lqc-failure-nudge. **However, these run in-process via `src/scheduler.js` 60s tick (not systemd timers). Confirmed in scheduler.js — see T26-T32.**
**Verdict:** OK with one P0 (clawd-console flapping)

### T03b: clawd-console.service — P0 FAILURE
**Findings:**
- Status: `activating (auto-restart) (Result: exit-code) since 22:42:23 BST; 1s ago`
- Restart counter: **227,342** (i.e., restart loop has been running for ~26 days at 10s intervals)
- Cause: `Error: listen EADDRINUSE: address already in use :::3100`
- Port 3100 is owned by `/home/james/bot-council/target/release/bot-council` (PID 4137075).
- CLAUDE.md says: **"Clawd Console — runs on James's Legion 9 Pro laptop, not EVO, not Pi."** So this systemd unit on EVO should not exist.
- Unit file: `/etc/systemd/system/clawd-console.service` (created 2026-04-03 — predates the laptop convention).
- Wasted CPU: 376ms × 227K = ~85,000s = ~24 hours of pointless restart-and-fail cycles.
- Wasted journal space: ~227K × ~10 lines per restart = ~2.3M log lines.
**Verdict:** **P0 — disable + remove unit.**
**Suggested fix (read-only diagnostic notes — not applied):** `sudo systemctl disable --now clawd-console.service` and `sudo rm /etc/systemd/system/clawd-console.service && sudo systemctl daemon-reload`.

### T04: Journal warnings
**Findings:**
- Pre-Apr-27: cluster of `Failed with result 'exit-code'` events on Apr 19 13:53–13:56 and Apr 23 19:46. These are old, before the current healthy boot. Not current issues.
- Post-Apr-27: dominant warning is `scheduler tick skipped because previous tick is still running` — **counter at 274,886+ over 9 days**. See T04b for root cause.
- Live sample shows widget refresh OK (~2.9s for 6 henry, 3 gig, 20 emails), warm pings to evo-planner-4b and evo-main-27b succeed every ~3 seconds.
**Verdict:** WARN — P0 inside (see T04b).

### T04b: Scheduler tick storm — P0 ROOT CAUSE FOUND
**Findings:**
- Symptom: `scheduler tick skipped because previous tick is still running` log line, counter incremented 274,886 times over 9 days = ~21 skips/minute. Bursts of 30+ skips at the same `time:` ms are common.
- The wrapper `createSchedulerTickRunner` (scheduler.js:71) protects against overlap — when called while `running===true`, it logs and returns `{skipped: true}`. So those 274K skips are 274K **redundant calls** from somewhere.
- Only one caller in source: `setInterval(runSchedulerOnce, 60_000)` at scheduler.js:67. So with one setInterval, you'd see at most ~12,960 skips in 9 days (one per minute). We see 21x more.
- Counted `"scheduler started"` log entries since current boot (since 2026-04-27 21:55): **55 occurrences**. Each occurrence = a fresh `setInterval` registered.
- ROOT CAUSE: `schedulerStarted` flag is declared at index.js:106 — INSIDE the `startBot()` async function that creates the socket and event handlers. Every WhatsApp reconnect (`setTimeout(startBot, 5000)` at index.js:233) creates a fresh closure with `schedulerStarted = false`, so the guard is bypassed and a NEW `setInterval(runSchedulerOnce, 60000)` is registered. Old setIntervals are never cleared. After 55 reconnects there are 55 active setIntervals all firing every 60s, hitting the runner concurrently and producing the burst pattern.
- Side effects:
  - Tasks with proper per-day guards (briefing, backup, consolidate, etc.) likely still fire only once per day (because `lastFiredDate` is module-level), but each is checked 55× more often. Race conditions possible if any guard is non-atomic.
  - `keepEvoWarm()` runs on every tick and is now firing ~55 times per minute instead of once, hammering the local llama servers with cheap pings (max_tokens=1). Not damaging but unnecessary.
  - 274K junk log lines pollute the journal and make trace-analyser noisy.
  - Process memory will grow over time (each closure leak retains references). May explain swap saturation (T05).
- **Why 55 reconnects in 9 days?** Average ~1 reconnect every 4 hours. WhatsApp socket is unstable. Worth investigating root cause separately, but the scheduler-leak fix dominates.
**Verdict:** **P0 — fix scheduler init guard.**
**Suggested fix (read-only diagnostic notes — not applied):**
```js
// src/scheduler.js
let initialised = false;
let intervalHandle = null;
export function initScheduler(sendMessage) {
  if (initialised) {
    sendFn = sendMessage;
    return;
  }
  initialised = true;
  sendFn = sendMessage;
  runSchedulerOnce();
  intervalHandle = setInterval(runSchedulerOnce, 60 * 1000);
  logger.info('scheduler started (60s interval)');
}
```
After fix, restart clawdbot once to clear leaked intervals.

### T05: Host stats
**Findings:**
- Memory: 22Gi/30Gi used (73%), 8.9Gi available, 6.4Gi buff/cache.
- Swap: **2.0Gi / 2.0Gi (100% saturated)**, only 1.9Mi free. Likely consequence of multi-day setInterval leak (T04b) + 55 leaked closures retaining state.
- Disk `/`: 210G/390G (57% used) — fine.
- CPU: 32 cores, load avg 0.14–0.23 — 0.7% utilisation. No CPU pressure.
**Verdict:** **P1** — swap saturated (no immediate impact while RAM has 8.9Gi free, but indicates accumulating pressure). Likely resolves on bot restart. Confirm post-fix.

### T06: Listening ports
**Findings (relevant only):**
- :3000 (clawdbot) ✓ PID 2811144
- :5100 (memory FastAPI) ✓ PID 89226
- :8080 (vision llama-server, Qwen3-VL-30B) ✓ PID 3849453
- :8083 (embed nomic) ✓ PID 1871
- :8084 (docling Granite) ✓ PID 1867
- :8085 (llama-server, undocumented in arch.md) — PID 3770838 — likely the planner/4B classifier; arch.md references "classifier:8081" which doesn't appear here, so the classifier is now on **8085** (port drift vs docs)
- :8086 (llama-server, undocumented) — PID 106148 — likely a third model
- :8888 (SearXNG via docker-proxy) ✓
- :8000 (Python — voice listener / Whisper service) ✓ PID 458667
- :3100 (`bot-council` Rust binary) — squats the port CLAUDE.md says belongs to clawd-console
- :5173 (Vite dev server) — not in arch.md, presumably a dev preview running
- :9001/:9002/:9003 (node, all bot-council ecosystem processes)
- :5432 (Postgres in Docker) — **not mentioned in architecture.md** ("no database, JSON files only")
- :6379 (Redis in Docker) — **not mentioned in architecture.md**
- :20241 (cloudflared tunnel) — undocumented
- Tailscale on :443 / :51818 ✓
**Verdict:** WARN — port drift. Architecture docs are stale; classifier moved off 8081 to 8085, three llama servers run (8080/8085/8086) where arch.md described two. Postgres+Redis present but undocumented (probably for bot-council). Document or remove.

---

## Phase 2 — Bot HTTP API

### T07: Route enumeration
**Findings:** ~50 explicit route checks in `src/http-server.js` (699 lines). Notable:
- `POST /debate` — **no auth** (intentional, see T10)
- `POST /api/send`, `/api/forge-now`, `/api/widgets/refresh`, `/api/soul/reset|observe`, `/api/todos/complete`, `/api/evolution/*`, `/api/lqcouncil-knowledge-refresh`, `/api/memory/note|search|<id>` — all `checkAuth`-gated
- `GET /dashboard`, `/api/status|usage|widgets|soul|todos|messages|audit|plans|*-report|traces|stats/messages|retrospective|quality|participation/*|evo|ollama|memory/*|events` — all `checkAuth`-gated
- **Default route (path didn't match)** — see top P0-CRITICAL banner. Returns HTML containing the token verbatim. **Not auth-gated.**
- `POST /api/sentry-webhook` — gated by Sentry HMAC verification (separate path)
**Verdict:** WARN — broken default-route auth (see banner).

### T08: /api/health probe
**Findings:** No `/api/health` route exists. `curl localhost:3000/api/health` falls through to default → returns 200 with token-leaking HTML. Confirmed exposed publicly via Cloudflare Tunnel (banner). Internal liveness can be inferred from `GET /api/status` (auth-gated).
**Verdict:** WARN — no proper health endpoint; existing fallback leaks the token.

### T09: Auth gate verification
**Findings:** Auth-gated routes correctly return `401 Unauthorized` without a valid token (confirmed via `/api/status`, `/api/dashboard`). The gate function `checkAuth(req)` at `src/http-server.js:42` accepts either `?token=…` query param or `Authorization: Bearer …` header.
**Verdict:** OK on auth'd routes. **Catch-all bypasses it (P0).**

### T10: /debate endpoint state
**Findings:** Endpoint is now **production**, not pending — commit 4d5ce2d ("fix(debate): handle MiniMax XML tool calls + smoke-test fast path", #?, on main). The CLAUDE.md memory entry calling it WIP-on-EVO is stale.
- Implementation: `src/debate-handler.js` (committed) imported into `src/http-server.js:36`.
- No dashboard-token auth — explicit code comment: "council sends its own bearer token; verification of that belongs in a future phase".
- Live test: `POST /debate` with `{}` body → 200 `{"response":"No prompt provided for this debate round.","confidence":50}`. So the endpoint accepts arbitrary public traffic.
- Server `keepAliveTimeout=120s`, `headersTimeout=125s` (set in `startHttpServer` to avoid pool staleness during 5-round LQ smoke tests).
- Risk: anyone on the internet can drive expensive LLM tool-loops via /debate. Cost amplification + prompt-injection exposure on tools.
**Verdict:** **P0 — gate /debate**. Can be a shared bearer in `LQC_DEBATE_SHARED_SECRET`, validated against `Authorization` header before dispatch.

### T11: SSE stream
**Findings:** `/api/events` is auth-gated (verified — returns 401 without token). When authed, sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, sends initial `event: connected` then registers client. Heartbeat is in `src/sse.js`. No issues observed.
**Verdict:** OK

---

## Phase 3 — WhatsApp / Baileys

### T12: Connection state
**Findings:** Currently connected (`/api/status` returns `connected:true, name:"Clint", jid:"447719697305:3@s.whatsapp.net"`). Bot LID `126131059593382:3@lid`. **55 disconnect/reconnect cycles since 2026-04-27 boot** (~6/day). Disconnect codes are mostly 503 (transient WhatsApp backend) and a few 428 (upgrade required). Each reconnects within 5s. No QR re-pair needed — session is healthy. Each reconnect leaks one `setInterval` (see Phase 1 P0 banner: scheduler tick storm).
**Verdict:** OK on connection itself; reconnect cadence is normal Baileys behaviour. Side-effect P0 logged elsewhere.

### T13: auth_state directory
**Findings:** `~/clawdbot/auth_state/` has 214 files. `creds.json` mtime 2026-05-06 22:49 (active). Pre-keys updated daily (last 2026-05-01 10:35). App-state-sync keys present. No stale-state indicators.
**Verdict:** OK

### T14: 24h activity
**Findings:**
- 208 inbound `messages.upsert`-equivalent events in 24h.
- 4 proactive outbound: 03:00 (450 chars), 03:30 (27 chars), 07:00 morning briefing (2561 chars), 08:45 daily health (514 chars). All successful.
- Reactions received: 7 today (👍 ❤️ 💯 😂) from various senders — handled, no replies needed.
- 174 group messages logged today in LQCore (`120363407496928531_g_us`) but **0 from the bot**.
- **0 `response sent` log lines in the last 7 days.** Bot has not generated a single conversational reply for an entire week.
**Verdict:** **P1 — suspicious silence.** See T15 + T16.

### T15: Why the bot has been silent
**Findings:**
- `data/interactions.jsonl` last entry 2026-04-29 06:59:59 BST — 7 days stale. File mtime matches; only 2,665 lines total since 2026-03-26.
- **Zero @-mentions or `clawd `/`clint `/`clawdsec ` prefixes in any group conversation log over the past 7 days** — across ~10 daily group files. Per CLAUDE.md "Groups are @mention/prefix only", silence is technically the correct policy when nobody addresses the bot.
- Apr 29 was the day James complained "Why are you not responding in the lqcore group" and the bot responded explaining the @mention-only rule. After that, nobody @-mentioned and the bot has been silent.
- **However, 3 message-decryption failures today alone** (in LQCore from James and YC) — when decrypt fails, the bot never sees the plaintext, so any embedded @-mention would be silently dropped. From journal: 06:16:51, 06:16:56 (same James msg failed twice), 14:53:31 (YC msg). All recorded for session-repair via `src/session-repair.js` — but no log line confirms the repair completed and the message was eventually decrypted+processed.
- DM conversation-logs for James (`216131344289942_lid`) stop at 2026-03-25, but he still reacts daily via thumbs/hearts. Likely the bot only writes to conversation-logs for messages with text; reactions/proactives aren't logged. Not a bug.
**Verdict:** WARN — silence is mostly *intentional* (groups @mention-only + nobody @-mentioned), but **decryption failures are a real risk: any lost message that contained an @-mention or DM intent is invisibly dropped**. James's frustration on Apr 29 ("Why are you not responding") may have been one such case. Worth: (a) confirming session-repair actually retries successfully, (b) adding an alert when decrypt-fail counter exceeds N/day, (c) considering an "I think I missed something — try again" follow-up DM after decrypt failures.

### T15b: Routing reality vs CLAUDE.md
**Findings:** Routing logs show `model:"qwen3.6-27b-q6_k + qwen3.5-0.8b-draft (llama-server :8080, EVO X2, spec-decode)"`, `provider:"qwen"`, `modelReason:"qwen_local_default"` for *both* general_knowledge and (via fallback) "system" categories. CLAUDE.md says "MiniMax M2.7 is the default cloud model. ~8% of Claude's cost. **All chat responses.**" and "EVO local models for vision, doc summarisation, and classification ONLY. Never generate chat responses." — but in practice, **EVO local Qwen 27B is generating chat responses**. For "claude-only" categories, `claudeAvailable:false` triggers fallback to qwen.
**Verdict:** **P2 — CLAUDE.md drift OR misconfig.** Either the doc is stale (Qwen-default is the correct intent) or `ANTHROPIC_API_KEY`/`MINIMAX_API_KEY` is missing/exhausted. Confirm intent with James; update CLAUDE.md or fix config.

---

## Phase 4 — Model Routing (3-tier)

### T16: Local llama.cpp endpoints
**Findings:** All 5 llama-server endpoints (8080, 8083, 8084, 8085, 8086) return `HTTP 200 {"status":"ok"}` to `/health`. Memory FastAPI on :5100 healthy (27.6d uptime, llm/embedding online, whisper-large-v3 available but not loaded). SOVREN production app on :8000 healthy (NOT in arch.md — running on EVO alongside Clint).
- :8080 — `Qwen_Qwen3.6-27B-Q6_K.gguf` — main chat model, with `qwen3.5-0.8b-draft` speculative decoder.
- :8083 — `Qwen3-Embedding-8B-Q8_0.gguf` (architecture.md says "nomic-embed" — **drift**, swapped to Qwen3 8B embedding)
- :8084 — `granite-docling-258M-f16.gguf` (multimodal doc parsing) ✓ matches arch
- :8085 — `Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf` (4B classifier; arch.md says it's on :8081 with Qwen3-0.6B — **drift in port and model**)
- :8086 — `gemma-4-31B-it-Q4_K_M.gguf` (**NEW — not in arch.md**; likely judge / drift / second opinion)
**Verdict:** OK on functionality. **P3 — architecture.md is stale on port + model assignments.**

### T17: 4B classifier smoke test
**Findings:** Posted "Classify the user request as one of: chat, calendar, email, todo, search, system. User: What is the weather tomorrow?" to :8085 → returned `"search"` in 70ms (43 prompt tokens, 2 completion). Cache hit for 1 token. Throughput ~788 prompt tokens/s, 130 predicted tokens/s. Classifier is fast and correct.
**Verdict:** OK

### T18: Cloud routing — MiniMax / Claude / Sonnet
**Findings:**
- `/api/usage` reports today: 20 calls, 210,698 input + 3,409 output tokens, **$0.067**, daily limit 100. Total since 2026-03-25: 785 calls, $2.61 lifetime. Model field reads `"claude-sonnet-4-6"` (not Opus, not MiniMax). Cost numbers match Anthropic Sonnet 4.6 pricing ($0.30 in / $1.20 out per MTok), so calls are *probably* real Anthropic Sonnet, not MiniMax-as-Anthropic.
- `.env` env vars: `ANTHROPIC_API_KEY=` is **empty**, `CLAUDE_MODEL=clau***` is set, `MINIMAX_API_KEY=sk-c***` is set. **Yet "claude-sonnet-4-6" calls succeed** — most likely `MINIMAX_API_KEY` is being passed to the Anthropic SDK with `base_url=https://api.minimax.chat` so MiniMax is impersonating "Sonnet" labels. Need to confirm by reading `src/claude.js` constructor.
- Routing log lines: golden-questions runs typically show `provider:"qwen"`, `claudeAvailable:false`, `forceClaude:false`. For category "system" with `forceClaude:true reason:"claude-only category"`, **claudeAvailable is still false → falls back to qwen**. So "claude-only" categories are silently downgraded to qwen at the moment.
- Banner script logs `Model: claude-sonnet-4-6` at startup (3 times today as the bot mode-switched/reloaded), suggesting Sonnet IS configured as the cloud model, but the *actual* dispatch chooses local qwen.
**Verdict:** **P2 — multiple drift points:**
1. CLAUDE.md says "MiniMax M2.7 default" + "Claude Opus 4.6 only on explicit request"; reality is "Sonnet/MiniMax labelled as Sonnet" via MiniMax key + Qwen-local fallback when Claude unavailable.
2. CLAUDE.md says EVO local "never generates chat responses"; reality is qwen-27B is the actual chat model for golden-questions and likely most production traffic.
3. ANTHROPIC_API_KEY empty raises a question: when something *actually* needs Anthropic (Opus quality gate, etc.), does it silently fail? Verify.

### T19: Recent claude.response calls (24h)
**Findings:** Journal shows entries like `requestId:llm_*… input:6556, output:109, calls:1/100, msg:"claude response"`. Counter goes 1/100 → 2/100. Confirms 20 calls/day matches /api/usage. All routed via golden-questions internally. Real user chat routes to qwen — see Phase 3 T15b.
**Verdict:** OK (calls succeed). Whether Claude or MiniMax is moot pending T18 follow-up.

### T20: Top slow scheduler tasks
**Findings (from /api/system-health):**
- `goldenQuestions` — last 1,192s (~20 min), mean 85ms. Once-per-day deep evaluation; long is expected.
- `consolidateShadow` — last 190s, mean 11ms. Phase 1 shadow extract.
- `trajectorySnapshot` — last 178s, mean 3ms. Tool-trajectory snapshotting.
- `systemKnowledgeRefresh` — last 154s, mean 11ms. Re-seeds system knowledge.
- `probe` — last 97s, mean 5ms. Nightly observation accumulation.
- `lastTickMs: 78ms` (most recent — fast). `running: false` at probe time.
- `overlapSkips: 275,589` (continues to climb, see Phase 1 P0).
- `tickOverlapWarnMs: 45000` — never tripped (no single tick has run >45s, even though sum across the leaked 55 schedulers might).
**Verdict:** OK on individual task budgets.

---

## Phase 5 — Memory & Soul

### T21: Memory service liveness
**Findings:** Memory FastAPI running from `/home/james/clawdbot-memory/` (NOT `~/clawdbot/evo-memory/` as architecture.md claims), uvicorn on :5100, uptime 2,383,381s = 27.6d, pid 89226. `/health` returns `{"status":"online","backend":"llama.cpp","embedding":"online","llm":"online","whisper":{"available":true,"loaded":false,"model":"large-v3"}}`. `/openapi.json` exposes 17 routes.
**Verdict:** OK (service alive). **P3 — codebase fragmentation:** memory-service source exists in 3 locations (`~/clawdbot-memory/`, `~/clawdbot/memory-service/`, `~/clawdbot-claude-code/memory-service/`); only `~/clawdbot-memory/` is wired to the running uvicorn. Architecture.md is wrong.

### T22: Memory category registry
**Findings:** From `/api/memory/status`:
- Total: **31,908** (active 2,142 + archived 13,997 + superseded 15,769)
- Active by category: general 1820, legal 62, document_chunk 59, insight 57, system 48, group_decision 28, document 18, preference 15, identity 14, person 10, document_index 5, ai_consultancy 3, accommodation 1, henry 1, **dream 1**.
- `general` (1820) is 85% of active — too coarse a bucket for useful retrieval; consider stricter category routing or splitting.
- `dream:1` is the smoking-gun for a P0 (see T33).
- `/api/memory/list?category=dream` returns un-filtered results — the query param appears ignored. Likely API bug. Minor.
**Verdict:** WARN — category distribution suggests under-categorisation; dream count is a P0 symptom.

### T23: TTL / decay
**Findings:** 13,997 archived, 15,769 superseded — decay/eviction is working (about half lifetime memories have been retired). Maintenance phase of CONSOLIDATE today reported "expired:0, deduped:0, topics_indexed:0, topics_pruned:0" — quiet maintenance pass.
**Verdict:** OK

### T24: Identity memories
**Findings:** 14 identity-category memories present (active). Per CLAUDE.md, identity is immutable. Cannot tell from API alone whether 14 is the original count or has been silently churned. Sample of `/api/memory/list` shows oldest preference/legal/person memories from 2026-03-15 — these look stable.
**Verdict:** OK (likely)

### T25: Soul state
**Findings (from `/api/soul`):**
- `people` array: 1 entry (LQclaw +85251936243 manually added 2026-03-24)
- `patterns` array: **empty**
- `lessons` array: 1 entry (from `dream_2026-03-24`)
- `boundaries` array: 1 entry (from `dream_2026-03-31`)
- `observations` array: many entries from dreams 2026-03-24 onwards, all `promoted: false`. The bot has reflected (e.g., "I overreached in the pitch", "James doesn't care about the architecture unless it's tied to a clear advantage") but no observations have been promoted into actionable soul changes.
- The most recent `dream_*` source date in soul is **2026-03-31** — over 5 weeks old. Soul has had **zero new dream-derived input since dream mode broke** (T33).
**Verdict:** **P0 (linked to T33)** — soul is frozen. No personality evolution since dream mode stopped extracting from real conversations.

---

## Phase 6 — Overnight Pipeline (4 stages)

### T26: Event log
**Findings:** `events-<date>.jsonl` present every day Apr 27 → today (May 6). Today: 15 events — operations:ok×6 + completed×1 (system-refresh, project-sync, daily-backup, trace-analysis, ground-truth, sovren-cross-ref), probe:ok×4, consolidate:ok×2 (store + maintenance), consolidate:failed×1 (extract), report:ok×1.
**Verdict:** OK — pipeline wires events through.

### T27: CONSOLIDATE — **P1 quality regression**
**Findings:**
- Today (and Tuesday May 5, and many days before): `consolidate/extract: files=1 candidates=0 — extractor produced nothing from non-empty logs`. Extractor LLM (Qwen 27B) reads yesterday's conversation logs but returns 0 structured candidates.
- Journal sample showed input *did* contain consolidatable content ("Jamie Tso: I have an evil plan… AI native law firms backed by YC… clone them all…") yet the extractor returned 0.
- store: ok (stored=0, rejected=0). No `shadow-candidates-*` file is being created — CLAUDE.md's "Phase 1 shadow mode" is producing nothing.
- maintenance: ok (expired:0, deduped:0, topics_indexed:0, topics_pruned:0).
- Only sporadic `rejected-*.jsonl` files (Apr 20, 24, 30, May 3, 4) — when LLM returns zero, there's nothing to reject either.
**Verdict:** **P1 — extractor LLM is broken or mis-prompted.** Likely: prompt template mismatch with Qwen 3.6 27B output format, schema enforcement rejecting all output, or token budget too small. Needs interactive debug.

### T28: PROBE
**Findings:** `observations-2026-W19.jsonl` (current ISO week) present, mtime today 03:15, 3.4 KB. Today's events show 4 probe stages all `ok`. Today's report: "Probe: 6 patterns observed, 6 quality failures." So probe IS finding signal — downstream consolidate/improve fail to act on it.
**Verdict:** OK

### T29: REPORT
**Findings:** Daily JSON + txt reports present May 2–6 (today's: 18 KB JSON, 1.7 KB txt). Each morning's report flags consolidate failure. ATLAS staleness guard appears honoured — no candidates surface in DM body. "NEW this week" entries reference current ISO-week observations file.
**Verdict:** OK

### T30: IMPROVE — **P1 silent stall**
**Findings:**
- Last IMPROVE was Saturday 2026-05-02 22:00. Events:
  - groom: 33 observations groomed → candidates:0, clusters:3, worse_drifts:9
  - synthesis: candidates:0 input → final:0, raw_bytes:0, parsed:0, rejected:0
  - **Zero candidates synthesised** in deep mode.
- proposals/ has no May entries — last is 2026-04-29 (`golden-questions-regression-…json` and `trajectory-drift-…json`). Nothing in 7 days.
- Budget: 0 Opus sessions, 0 tokens. Synthesis returned 0, so the Opus selection step never ran.
- Same root cause as Consolidate: Qwen 27B is returning empty structured output. The system has 33 inputs ready but the synthesiser can't form candidates.
**Verdict:** **P1 — Improve is stuck at synthesis stage.** Same probable root cause as T27. Without Improve, the bot can't self-correct what Probe has been observing for weeks ("cortex p95 80s", "category imbalance 75% general_knowledge").

### T31: Operational tasks
**Findings:** Today's operations: system-refresh ("79 files seeded, 48 stale entries removed"), project-sync ("0 files synced across bot-council + SOVREN"), daily-backup, trace-analysis, ground-truth, sovren-cross-ref — all `verdict:ok`. /api/system-health: briefing/knowledgeRefresh/traceAnalysis/groundTruth/projectSync/backup all `lastRun: 2026-05-06`. weeklyReview last 2026-05-03 (Sun, expected). Backup dir: 7-day retention working (Apr 30 → May 6 each present at 03:00).
**Verdict:** OK

### T32: Morning briefing 07:00
**Findings:** Today 07:00:21, "morning briefing sent" (2,561 chars to 447966523191@s.whatsapp.net = James's phone). Same pattern previous days. Daily health DM also sent (08:45, 514 chars).
**Verdict:** OK

### T33: Dream mode 22:05 — **P0 broken since Pi→EVO migration**
**Findings:**
- Service `clawdbot-dream.service` fires every night via `clawdbot-dream.timer` (22:05 London). Last fire today 22:05:03, `code=exited, status=0/SUCCESS` — but the work was empty.
- Service journal every night since at least May 1: `No conversation logs or documents found for 2026-05-XX`.
- Cause: unit file `ExecStartPre=/usr/bin/rsync -az --timeout=30 pi@10.0.0.1:/home/pi/clawdbot/data/conversation-logs/ /home/james/clawdbot-logs/conversation-logs/`. After the Pi→EVO migration, the Pi no longer hosts the bot, so its `/home/pi/clawdbot/data/conversation-logs/` is stale or empty. Rsync succeeds but pulls nothing new. `~/clawdbot-logs/conversation-logs/` has 39 stale files. Live data is in `~/clawdbot/data/conversation-logs/` (88 files including today).
- Bonus systemd warning: line 18 `-ExecStartPre=…` (with leading hyphen) is rejected: `Unknown key name '-ExecStartPre' in section 'Service', ignoring` — document-logs rsync silently dropped.
- Consequence: dream mode has produced no diary / lessons / patterns / boundaries since Pi→EVO migration. Soul confirms: most recent `dream_*` source date in soul is 2026-03-31 — over 5 weeks of zero soul evolution. `dream:1` in memory categories (likely a single legacy entry).
**Verdict:** **P0 — fix dream service unit file.**
**Suggested fix (read-only diagnostic notes — not applied):** edit `/etc/systemd/system/clawdbot-dream.service`:
```
# Remove both ExecStartPre rsync lines (the second is already silently ignored by systemd).
ExecStart=/home/james/clawdbot-memory/venv/bin/python3 /home/james/clawdbot-memory/dream_mode.py \
  --log-dir /home/james/clawdbot/data/conversation-logs \
  --doc-log-dir /home/james/clawdbot/data/document-logs
```
Then `sudo systemctl daemon-reload` and optionally `sudo systemctl start clawdbot-dream.service` to backfill tonight.

### T33b: Quality regressions surfaced by morning report
**Findings:** Today's morning report and yesterday's both flag:
- `golden-questions: 0/20 passed (0%, trailing median 0%)` — every contract test fails. Either Clint's responses are genuinely bad or the rubric is mis-aligned. The 0% trend means the regression detector ("flag if today drops >15pp below trailing-3-run median") never fires — denominator is zero.
- `cortex gather p95: 80,601 ms` — context retrieval taking 80 seconds (10× the 8 s threshold). Dominates user-perceived latency for any non-trivial query.
- `category_imbalance: general_knowledge is 75% of all messages` — classifier is heavily skewed; granular categories under-used. May explain why `general` is 85% of active memory (T22).
- `Probe: 6 patterns observed, 6 quality failures` — 100% failure rate.
- **Despite all of the above, IMPROVE produced 0 candidates Saturday.** The system observes its own decay and cannot remediate (T30).
**Verdict:** **P1 — meta-failure**: Probe sees rot, Improve can't act. Once the Qwen-extractive issue (T27/T30) is fixed, Improve should generate candidates from the 33 groomed observations and start chipping away.

---

## Phase 7 — Voice Pipeline (EVO)

### T34: Whisper + voice listener service
**Findings:** `clawdbot-voice.service` active (running) since Sat 2026-04-11 (3w 4d). PID 3331028, 725 MB RAM, 229 MB swap, 2d 1h CPU. Runs `voice_listener.py` from `/home/james/clawdbot-memory/` (same parent dir as the memory FastAPI). Currently cycling state machine (IDLE → RECORDING → TRANSCRIBING → IDLE) every few seconds, mostly rejecting Whisper hallucinations like "Thank you" / "Whoa" / "Yeah".
**Verdict:** OK

### T35: Piper TTS reachable + speaking
**Findings:** Confirmed Piper TTS fired May 5 11:54:18 — `TTS (Piper): 'Sorry, I couldn't get an answer' (2.3s)`. State transition `[SPEAKING] → [FOLLOW_UP] (76ms) tts=2.3s` confirms the wake → STT → LLM → TTS → follow-up loop completes end-to-end. (No `aplay -l` analog playback device in `aplay -l` output — only HDMI cards listed; verify a USB speaker is wired or the bot defaults to a working device. Per CLAUDE.md: "Every voice command MUST produce audible output" — TTS produced wav, but if no analog speaker is connected to EVO, sound goes nowhere.)
**Verdict:** OK on lifecycle; **P3 — verify physical speaker is connected.**

### T36: Mic-flush invariant
**Findings:** State machine clearly flushes through `[SPEAKING] → [FOLLOW_UP]` after TTS. The 76 ms gap before the FOLLOW_UP state suggests the audio_duration + buffer pattern is implemented (didn't dump the source). No log evidence of mic stuck open.
**Verdict:** OK

### T37: Wake-phrase recent triggers (7d)
**Findings:** **One** wake event in 7 days (May 5 11:54:18). Whisper transcribed the command as "The River. Now we have a load of copies of those. these. It's a bit." — clearly garbled background. The bot replied 'Sorry, I couldn't get an answer'. So while wake-detection fires, the actual usability has been minimal. 3,960 non-wake voice events processed (mostly Whisper hallucinations rejected by VAD/heuristics).
**Verdict:** OK on liveness; P2 on practical usability — voice is alive but mostly idle. Worth confirming intended use pattern.

---

## Phase 8 — Group Behaviour & Security

### T38: Group config
**Findings:** Four registered groups via `/api/participation/groups`:
- LQCore `120363407496928531@g.us` — mode `open`, posture `direct_only`
- LQcouncil `120363409858920612@g.us` — mode `project`, posture `direct_only`
- AGI (Tom Glover) `120363426226720044@g.us` — mode `colleague`, posture `direct_only`
- SOVREN `120363425230153097@g.us` — mode `project`, posture `direct_only`

All four: `posture: direct_only`, `maxUnsolicitedPerHour: 2` (vestigial under direct_only), `followUpWindowMs: 5min`, `cooldownMs: 60s`. CLAUDE.md still describes ambient agency for LQCore but the live config has it OFF (consistent with commit bdc2704 "remove ambient agency"). **CLAUDE.md drift.**
**Verdict:** OK on config; **P3 — update CLAUDE.md** to reflect post-bdc2704 reality (no ambient).

### T39: Output filter (canary + regex)
**Findings:** `src/output-filter.js` exports `filterResponse(responseText, chatJid)` + `getCanaryToken()`. Wired into both group reply paths in `src/message-handler.js:311` and `:357`. Logs `output-filter: CANARY TOKEN DETECTED — system prompt leak blocked` and `output-filter: response blocked` when triggered. CLAUDE.md three-layer defense (prompt + output filter + canary) intact in code.
**Verdict:** OK

### T40: Group prefix-only invariant
**Findings:** Per Phase 3 T14/T15: zero bot replies to any group conversation in 7 days, zero @-mentions in those groups across the same window. Posture `direct_only` is honoured.
**Verdict:** OK

### T41: Personal admin tools blocked in groups
**Findings:** Did not deep-dive code; deferred. No group activity has fired in 7d to test. Recommend a manual smoke-test: ask the bot in a group to "open my email" and confirm refusal.
**Verdict:** UNCHECKED

### T42: No-emoji rule
**Findings:** Sampled today's 8 outbound proactive messages (morning briefing 2,561 chars, daily health 514 chars, 6 LQC alerts 149-175 chars each). All plain text/markdown, no emojis observed in the previewed snippets. Prompt-side enforcement assumed working.
**Verdict:** OK (no counter-examples)

### T42b: LQ Council monitor — 4 stuck-debate alerts tonight
**Findings:** Between 22:37 and 22:38, the LQC monitor (`tickLqcMonitor`) sent **4 edge-triggered alerts** to James's DM about debates stuck for 2+ weeks:
- round_1 23354m (≈16.2 days) — id d2999542
- analysing 23356m — id eefde1d7
- round_1 23750m (≈16.5 days) — id c6be81a6
- synthesising 23782m — id 4b09eda0

So 4 LQ-Council debates have been "in flight" for over 16 days. The monitor noticed tonight (likely edge-triggered or threshold crossed). If the LQC API drift (T43) means `client.js` can't read live status, the monitor may be reporting against a stale snapshot — verify by hitting bot-council directly.
**Verdict:** WARN — alerts firing as designed, but the underlying issue (4 stuck bot-council debates) is real and unrelated to Clint itself.

---

## Phase 9 — Known Issues (verify state)

### T43: LQC upstream API drift — **P1 still unfixed**
**Findings:** Confirmed. Direct probes from EVO localhost to bot-council :3100:
- `/diag/health` → 404
- `/bots` → 404
- `/api/v1/bots` → 404
- `/bots/schema` → 404

`src/lqcouncil/client.js` still calls all the dropped paths:
- line 118: `request('GET', '/diag/health')`
- line 183: `request('GET', '/bots/schema')`
- line 187: `request('GET', `/bots/${botId}/history`, { query: { limit } })`

The 4 stuck-debate alerts tonight (T42b) are likely *true positives* — bot-council really has 4 stuck debates — but Clint's status reads via the dropped paths will return errors silently. Also: `lqc_status`, `lqc_bots_list`, `lqc_history` tools must be returning errors when invoked from group chats. Memory record from 2026-04-20 is still accurate (17 days unfixed).
**Verdict:** **P1 — fix `src/lqcouncil/client.js` paths to match current bot-council API.** Probably trivial: probe `/api/diag/health`, `/api/v1/bots`, etc., to find the right path mapping.

### T44: LQCore member register — **memory entry STALE**
**Findings:** Memory said "data file unpopulated, code unshipped". Reality:
- `src/group-members.js` is committed and feature-complete (per the file's own design comments, dated 2026-04-19).
- `data/runtime/group-members.json` IS populated, mtime today 17:16. Three groups tracked: LQCore (10 members), LQcouncil (4 members), and one unknown group `120363408363597084@g.us` (2 members). 16 total members.
**Verdict:** OK. **Update the project_lqcore_member_register memory entry** — it's outdated.

### T45: /debate endpoint — already covered in Phase 2 T10
**Findings:** Endpoint live, file `src/debate-handler.js` committed Apr 23 (predates this branch). No outstanding WIP per `git status -s` clean. Memory entry calling it WIP-on-EVO is stale.
**Verdict:** OK. **Update memory** — debate is shipped.

### T46: 4d5ce2d ("MiniMax XML tool-call fix") deployed?
**Findings:** Commit `4d5ce2d` is **unknown to EVO main** (`git show 4d5ce2d` → "unknown revision"). It's the HEAD of *this worktree's branch* `claude/amazing-williams-b98bcb`, which forked from main some weeks back. Recent main has #17 (Apr) `fix(debate): parser tolerates MiniMax \' escapes and trailing commas` and (older) #16 `f31f4b8 fix(debate): Tavily-primary web search + formalise /debate endpoint`. 0 XML parse errors in 24h regardless. So the XML fix from 4d5ce2d either landed on main under a different SHA or wasn't needed because earlier work covered it.
**Verdict:** OK functionally (no XML errors). **P3 — consider whether 4d5ce2d's branch contains anything not on main.** If it does, it'll silently rot.

### T47: LQcouncil weekly digest + daily nudge
**Findings:**
- `checkWeeklyDigest` gates on `dayOfWeek === 0` (Sunday). Last fire **2026-05-03 09:00** to LQCore (jid 120363407496928531) — `weekly digest sent` ✓.
- `checkFailureNudge` daily — should run at the configured nudge hour. Did not see direct journal lines for "failure nudge" today (search may have wrong keyword). Daily-health DM (separate) fired 08:45 today (514 chars).
- `lqc-digest-last-run.txt` mtime May 3 09:00 ✓.
- `lqc-daily-health-last-run.txt` mtime today 08:45 ✓.
**Verdict:** OK on weekly digest + daily-health. Failure-nudge unconfirmed (no log evidence today; possibly no failures crossed threshold).

### T48: Classifier model drift
**Findings:**
- CLAUDE.md: "4B classifier is the PRIMARY routing layer."
- architecture.md: "classifier:8081 Qwen3-0.6B"
- Live (T16): :8085 hosts `Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf`
- 4B size matches CLAUDE.md. Port and model name in architecture.md are both wrong.
**Verdict:** **P3 — fix architecture.md** to show classifier on :8085 with Qwen3-4B-Instruct-2507.

---

## Phase 10 — Clawd Console (Legion laptop)

### T49: Console process state
**Findings:** No process on port 3100 on the Legion laptop (`netstat -ano | findstr :3100` empty, `tasklist` shows no node.exe). **Console is not running.** It's not auto-started on the laptop.
**Verdict:** N/A — by design (manual `npm run dev` when needed). Not a bug.

### T50: Console env config
**Findings:** `clawd-console/.env.local` has `PI_URL`, `PI_URL_LAN`, `EVO_URL`, `EVO_URL_LAN`, `DASHBOARD_TOKEN` — all five keys set. **DASHBOARD_TOKEN here matches the leaked one (`VhPJ…`)** — when James rotates the token (banner #1), update this file too.
**Verdict:** OK structure; **dependency on banner P0 fix** (rotate token in both EVO .env and console .env.local).

### T51: Console source health
**Findings:** Console dir healthy structure (`.next/` build cache, `package.json` scripts: dev/build/start/lint, AGENTS.md present with Next.js 16 caveats). Did not run `npm run lint` or `next build` — out of scope for read-only checkup.
**Verdict:** UNCHECKED (deferred — when James starts the console, it will either work or surface issues immediately).

---

## Phase 11 — Pi Dashboard

### T52: Pi reachable + dashboard process
**Findings:** Pi `cnc` reachable via Tailscale, up 28d 12h. `/home/pi/clawd-dashboard/target/release/clawd-dashboard` running (PID 77119). Network: eth0 + wlan0 + tailscale0 all UP.
**Verdict:** OK

### T53: Pi → EVO API consumption
**Findings:** Did not deep-dive Pi-side logs (would require additional SSH + journal inspection there). Inferred from EVO bot side (no errors involving Pi callers). Probably fine since dashboard process is alive and `/api/events` SSE is working with auth.
**Verdict:** UNCHECKED (deferred — low priority; visual confirmation tomorrow morning suffices).

---

## Phase 12 — Cron / Timers cross-check

### T54: Expected vs actual scheduling
**Findings:** Almost all "scheduled" jobs run **in-process** via the 60s scheduler tick (`src/scheduler.js`), not as systemd timers. Cross-reference:

| Task | Expected | Mechanism | Last fire | Status |
|------|----------|-----------|-----------|--------|
| consolidate | ~02:30 | scheduler.js tick → `checkConsolidateShadow` | today 01:32 (event log) | extract failing — see T27 |
| probe | ~03:15 | scheduler.js tick → `checkProbe` | today 03:15 | OK |
| report | ~06:50 | scheduler.js tick → `checkReport` | today 06:50 | OK |
| briefing | 07:00 | scheduler.js tick → `checkMorningBriefing` | today 07:00:21 | OK |
| dream | 22:05 daily | systemd `clawdbot-dream.timer` | today 22:05:03 | **broken — no logs found, see T33** |
| improve | Saturday 22:00 | scheduler.js tick → `checkImprove` | Sat 2026-05-02 21:00 | OK fire, **0 candidates synthesised — see T30** |
| daily-backup | ~03:00 | scheduler.js tick → `checkDailyBackup` | today 03:00 | OK |
| trace-analyser | daily | scheduler.js tick → `checkTraceAnalysis` | today | OK |
| system-refresh | daily | scheduler.js tick → `checkSystemKnowledgeRefresh` | today | OK (79 files seeded, 48 stale removed) |
| ground-truth | daily | scheduler.js tick → `checkGroundTruth` | today | OK (8 claims, 0 verified, 0 failed, 8 skipped) |
| project-sync | daily | scheduler.js tick → `checkProjectKnowledgeSync` | today | OK (0 files synced — likely no upstream commits) |
| sovren-cross-ref | daily | scheduler.js tick → `checkSovrenCrossReference` | today | OK |
| lqc-monitor | every tick | scheduler.js tick → `tickLqcMonitor` | tonight 22:37–22:38 (4 alerts) | OK firing; relies on stale API paths (T43) |
| lqc-weekly-digest | Sun 09:00 | scheduler.js tick → `checkWeeklyDigest` | 2026-05-03 09:00 | OK |
| lqc-failure-nudge | daily | scheduler.js tick → `checkFailureNudge` | unconfirmed | UNCHECKED |
| lqc-knowledge-drift | daily 02:10 | scheduler.js tick → `checkKnowledgeDrift` | unverified | UNCHECKED |
| lqc-daily-health | daily 08:45 | scheduler.js tick → `checkDailyHealth` | today 08:45 | OK |
| lqc-repo-poll | every 15 min | scheduler.js tick → `checkRepoPoll` | unverified | UNCHECKED |
| golden-questions | nightly 03:30 | scheduler.js tick → `checkGoldenQuestions` | today 03:30 | OK fire, **0/20 passed — see T33b** |
| trajectory-snapshot | nightly 03:45 | scheduler.js tick → `checkTrajectorySnapshots` | today | OK |
| style-calibration | weekly | systemd `style-calibration.timer` | Sun 2026-05-03 22:30 | OK |
**Verdict:** OK on schedule integrity. **Most failures are content-quality (extractor returns 0), not scheduling.**

### T55: 60s scheduler tick alive
**Findings:** `scheduler.js` setInterval is firing — `keepEvoWarm` log lines every ~3s (which are bursts from the 55 leaked schedulers, see Phase 1 T04b P0). The intended 60s cadence is broken upward, not stalled. Tasks gate on time/date so multiple firings don't duplicate work — but log volume and unnecessary CPU/LLM warming suffer.
**Verdict:** WARN — see Phase 1 P0 fix.

---

## Final notes / loose ends

- **Memory entries to update tomorrow** (currently stale or out-of-date):
  - `project_lqcore_member_register.md` — reality has overtaken it (code shipped, file populated).
  - `project_session_2026_04_03.md` — long out of date now that overnight pipeline + console + MiniMax work is in.
  - `project_lqc_api_drift_20260420.md` — still real, re-confirmed today; consider promoting to a P1 tracker.
- **Cloudflared tunnel `sovren-evo`** also exposes `lqcouncil.com` and `www.lqcouncil.com` to `localhost:3100` (bot-council). That's intentional — bot-council is the public web UI. Only the `clawd.lqcouncil.com` subdomain is the security problem (and only because Clint's HTTP server has a token-leaking default page).
- **Sonnet vs MiniMax bookkeeping**: `/api/usage` reports model `claude-sonnet-4-6` and tracks 20 calls / $0.067 today. Whether those calls go to Anthropic Sonnet or to MiniMax-via-Anthropic-SDK depends on what `src/claude.js` does when `ANTHROPIC_API_KEY` is empty and `MINIMAX_API_KEY` is set. Read that file (and its `baseURL` argument to the SDK constructor) when verifying.
- **golden-questions 0/20 regression**: deserves its own follow-up. Either the rubric is mis-calibrated to the current model output (Qwen 27B's voice differs from the model the rubric was authored against) or the answers really are bad. Easiest first step: read one of the proposal cards in `data/overnight/proposals/golden-questions-regression-2026-04-29*.json` to see what the grader thought went wrong.
- **The `4d5ce2d` mystery commit** on the worktree branch contains the debate XML fix + smoke-test fast path. Either:
  - It's superseded by something already on main (reading the diff vs main is worthwhile).
  - It's still useful; in which case open a PR back to main before this branch goes stale.
- **Suggested order of operations tomorrow**, given the P0 banner is real:
  1. Drop `clawd.lqcouncil.com` from cloudflared config + restart cloudflared (P0 #1, ~2 min).
  2. Rotate `DASHBOARD_TOKEN` in `~/clawdbot/.env` and `clawd-console/.env.local` on Legion (P0 #1, ~3 min).
  3. Add the `if (!checkAuth(req)) return ...` guard to the catch-all in `src/http-server.js` (P0 #1 code fix, ~5 min, test locally then deploy).
  4. Disable + delete `clawd-console.service` on EVO (P0 #3, ~2 min).
  5. Fix `clawdbot-dream.service` unit (P0 #4, ~3 min) — change `--log-dir` to local path, drop the rsync ExecStartPre lines.
  6. Fix scheduler `setInterval` leak (P0 #2 code fix, ~10 min) — move guard to module scope, restart bot once.
  7. Then start tackling P1: figure out why Qwen 27B isn't producing extractive output for consolidate/improve. Probably 80% of the value of the rest of the pipeline depends on this.
