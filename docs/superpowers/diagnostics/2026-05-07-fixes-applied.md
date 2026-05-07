# Clint fixes applied — 2026-05-07

> Companion to `2026-05-06-clint-full-checkup.md`. James said "ok start" 09:19 BST.
> All fixes applied directly on EVO; one is on a non-pushable branch (deploy key is read-only).
> Bot restarted once at 09:32:04 BST with new code + new token.

## What was applied (in order)

### 1. Cloudflared public exposure killed
- Edited `/home/james/.cloudflared/config.yml` on EVO — removed the `clawd.lqcouncil.com → http://localhost:3000` ingress block.
- Backup at `/home/james/.cloudflared/config.yml.bak-20260507-clawd-removed`.
- Restarted via `sudo systemctl restart sovren-cloudflared` (the actual unit name; systemd unit is `sovren-cloudflared`, not `cloudflared`).
- **Verified:** `curl https://clawd.lqcouncil.com/` from this Windows laptop now returns `HTTP 404`. `https://lqcouncil.com/` still returns 200 (bot-council frontend untouched).

### 2. `clawd-console.service` removed from EVO
- Stopped + disabled, removed `/etc/systemd/system/clawd-console.service`, daemon-reload.
- 26-day restart loop ended (counter was at 227,342). No more EADDRINUSE log spam.

### 3. `clawdbot-dream.service` unit rewritten
- Backup at `/etc/systemd/system/clawdbot-dream.service.bak-20260507`.
- Removed both `ExecStartPre` rsync lines (Pi source was stale post-migration; systemd was silently dropping the second one anyway because the leading `-` is invalid in this position).
- Removed `PI_URL` and `PI_LOG_DIR` env vars.
- `ExecStart` now points at the live local paths: `--log-dir /home/james/clawdbot/data/conversation-logs --doc-log-dir /home/james/clawdbot/data/document-logs`.
- daemon-reload run.

### 4. Code fixes in `~/clawdbot/src/`
**Branch on EVO:** `fix/security-and-scheduler-leak` (commit `982283c`), branched from `origin/main`.
**NOT pushed to GitHub:** EVO's deploy key is read-only — `git push origin fix/...` returns "key marked as read only". James will need to push the branch from his laptop (it's also accessible via `evo` remote = `james@100.90.66.54:clawdbot`).

**a) `src/http-server.js`** — auth-gate the catch-all default route. Was: `if (sock?.user?.id) { res.end('<a href="/dashboard?token=${config.dashboardToken}">'); }` reachable by any unauthenticated GET. Now: `if (!checkAuth(req)) return json(res, 401, { error: "Unauthorized" });` before that block.

**b) `src/index.js`** — hoisted `let schedulerStarted = false;` from inside `startBot()` (line 106) to module scope (line 43). Each WhatsApp reconnect was creating a fresh closure → fresh flag → another `setInterval(runSchedulerOnce, 60000)`. After 9 days the OLD process had 55 leaked intervals and 304K skip-tick warnings. Now: one scheduler per process.

### 5. `clawdbot-memory/dream_mode.py` — patches outside the main repo
The memory service runs from `~/clawdbot-memory/` (not in the clawdbot git repo). Two file edits made directly there:

**a) Line 26** — `PI_URL` default changed from `'http://10.0.0.1:3000'` to `'http://localhost:3000'`. Old default pointed at the (now-decommissioned) Pi bot endpoint, so dream's `/api/soul/observe` POSTs were getting `Connection refused`. Backup at `dream_mode.py.bak-20260507`.

**b) Line 1352** — commented out `prune_stale_memories(date_str)` call. The function was being invoked but never defined anywhere in the repo (`grep -r "def prune_stale" /home/james/` returns nothing). This was crashing every dream run with `NameError` *after* the LLM extraction work was already complete. Now the prune step is skipped. Add a `def prune_stale_memories(date_str): pass` stub or restore the function to fix properly.

### 6. `clawdbot-memory/voice_listener.py` — token fallback hardened
- Line 116 was: `os.environ.get("DASHBOARD_TOKEN", "VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM")` — the leaked token hardcoded as a fallback.
- Now: `os.environ.get("DASHBOARD_TOKEN", "")` — if the env isn't set, requests fail with no token (which is correct). The systemd unit's `Environment=DASHBOARD_TOKEN=...` provides the value normally.
- Backup at `voice_listener.py.bak-20260507-pre-rotate`.

### 7. Token rotation (`DASHBOARD_TOKEN`)
**Old:** `VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM` (leaked publicly via clawd.lqcouncil.com for ~16 days; assume compromised).
**New:** stored on EVO at `/tmp/newtoken.txt` (chmod 600). 42-char random base64-derived. Updated everywhere it's used:

- `~/clawdbot/.env` on EVO — backup at `~/clawdbot/.env.bak-20260507-pre-rotate`.
- `/etc/systemd/system/clawdbot-voice.service` `Environment=DASHBOARD_TOKEN=...`.
- `/etc/systemd/system/clawdbot-dream.service` `Environment=DASHBOARD_TOKEN=...`.
- `clawd-console/.env.local` on this Windows laptop — backup at `.env.local.bak-20260507`.

**Live processes restarted with the new token:**
- `clawdbot.service` (the bot) — restarted 09:32:04 BST.
- `clawdbot-voice.service` — restarted 09:30 BST.
- `clawdbot-dream.service` — restarted 09:33:51 BST (one-off, will re-run nightly via timer).

**Stale references to the old token** (low priority — not actively executing the old token):
- `~/clawdbot/.env.bak-*` (3 backup files) — historical, leave or delete.
- `~/clawdbot/evo-voice/clawdbot-voice.service` — the in-repo copy of the unit, **not** the live `/etc/systemd/system/...` copy. Update for consistency.
- `~/clawdbot/evo-voice/voice_listener.py` — in-repo (the live one is in `clawdbot-memory/`). Update for consistency.
- `~/clawdbot/evo-evolve/run-evolution.sh` — self-improvement script, may or may not run with the old hardcoded token. Update.
- `~/clawdbot/pi-voice/clawdbot-voice.service` — legacy Pi version, not in use.
- `~/clawdbot/docs/plans/*` — documentation, low risk.

## Verification (read-only, all confirmed live on EVO)

- **Old token rejected:** `curl -H "Authorization: Bearer VhPJ..." http://localhost:3000/api/status` → `HTTP 401`.
- **New token accepted:** same curl with new token → `HTTP 200`, `{"connected":true,"name":"Clint",...}`.
- **Catch-all without auth:** `curl http://localhost:3000/` → `HTTP 401 {"error":"Unauthorized"}` (was: 200 with token-leaking HTML).
- **Catch-all with auth:** returns the connected page; the dashboard link still embeds the token but that's the AUTHENTICATED USER'S OWN token, fine.
- **Public clawd.lqcouncil.com:** `HTTP 404` from external.
- **Bot status post-restart:** WhatsApp connected, EVO online, heap 118 MB (down from 287 MB pre-restart — the closure leak was eating memory).
- **Scheduler:** `overlapSkips: 0`, `running: false`, exactly one `scheduler started` log line since restart, 0 `tick skipped` log lines since restart.
- **Memory service:** uptime 28 days unchanged — was not restarted.

## What James needs to do tomorrow

### Required to get the fix on origin/main
1. From your laptop (which has GitHub write credentials):
   ```bash
   cd /path/to/clawdbot
   git fetch evo  # the evo remote is james@100.90.66.54:clawdbot
   git checkout -b fix/security-and-scheduler-leak evo/fix/security-and-scheduler-leak
   git push origin fix/security-and-scheduler-leak
   ```
2. Open PR on GitHub against main, review the diff (only `src/http-server.js` + `src/index.js`, +12/-2 lines), squash-merge.
3. Run the deploy script: `ssh james@100.90.66.54 '~/clawdbot/scripts/deploy-clawdbot.sh'`. Note: this will reset EVO to origin/main and the live bot will pick up the same code as currently running, plus restart cleanly.
4. After the deploy, EVO will be back on `main` instead of the local `fix/...` branch.

### Optional cleanup
- Restore `prune_stale_memories(date_str)` in `~/clawdbot-memory/dream_mode.py` (or define it as a no-op explicitly). The commented-out call is at line 1352. Whatever the function was meant to do — soft-demote or hard-prune memories that are stale — currently nothing happens at that step.
- Update the in-repo copies of `evo-voice/clawdbot-voice.service` and `evo-voice/voice_listener.py` so the new token is in source-of-truth too (not just the runtime copies).
- Decide whether to keep the (currently disabled and removed) `clawd-console.service` unit file lying around in the repo at `~/clawdbot/evo-system/` if it exists there. CLAUDE.md says console belongs on Legion only.
- Add a follow-up commit that documents the catch-all fix (or rewrites the page to not include the token in the link at all — even for authed users, putting it in HTML is bad form because of caching / shoulder-surfing).
- Eventually re-enable `clawd.lqcouncil.com` (if you want it back) only AFTER all of: catch-all fix is on main + token has been rotated + you've decided what should be on the public side. The current state is: tunnel is dead, catch-all is auth-gated, token is fresh. Safe.

## P1 also addressed (later same day)

After James said "run all proposed fixes/phases, and then test thoroughly", I dug into the remaining P1s. Result: **all six are now resolved or downgraded**, with 4 more commits on the same `fix/security-and-scheduler-leak` branch.

### Commit `5394550 fix(overnight): bump LLM timeouts so consolidate+improve stop returning 0`
**What was wrong:** `MEMORY_EXTRACT` was 120s. Qwen 27B on a 14K-char LQCore log takes about 6 minutes (linear-ish in input length — verified: 2.7K → 73s). Every consolidate run on a real day's log timed out and looked like a "silent zero". Improve was even worse — `evoSimpleChat` hardcoded `DOC_SUMMARISE` (30s) but synthesise sends ~33 groomed observations, blows past 30s, returns null, `raw_bytes:0`.

**Fix:**
- `src/constants.js`: `MEMORY_EXTRACT` 120s → 600s.
- `src/evo-llm.js`: `evoSimpleChat(systemPrompt, userMessage, maxTokens, timeoutMs?)` — new optional fourth arg, defaults to `DOC_SUMMARISE` for back-compat.
- `src/overnight/improve-task.ts`: synthesis client passes `TIMEOUTS.MEMORY_EXTRACT` (600s) instead of relying on the 30s default.

### Commit `59c8d8f fix(traces): timeMs in non-plan path was logging full route latency, not cortex`
**What was wrong:** `src/claude.js:526` set `routing.timeMs = Date.now() - routeStart`, i.e. the full request latency including the LLM call (30-80s when tools fire). The trace-analyser at `src/tasks/trace-analyser.js` uses that field as cortex p95 vs an 8s threshold — so every overnight golden-question batch tripped a `slow_cortex` anomaly. The needsPlan=true path at line 357 already used `cortexTiming.totalMs` correctly; line 526 was the inconsistent one.

**Fix:** line 526 now uses `cortexTiming.totalMs` and adds `classifyMs: cortexTiming.phase1Ms` for symmetry. Forward-only — old traces age out of the 7-day window and the slow_cortex anomaly will stop firing on its own.

### Commit `cde164d fix(golden-questions): use LQC dev group JID so LQ knowledge fragment is injected`
**What was wrong:** the test harness used `synthChat = 'golden-questions@test.clint'`. The LQ-Council knowledge fragment is gated in `src/prompt.js` on `isGroup && (chatJid === lqcDevGroupJid || group.allowedProjects.includes('lqcouncil'))`. The synthetic JID isn't a group and isn't the dev group, so the fragment was never injected and the bot was answering LQ-specific questions blind. Hence 0/20 every day.

**Fix:** `synthChat = config.lqcDevGroupJid || 'golden-questions@test.clint'`. Verified that `getResponse` does NOT call `pushMessage` (buffer pushes only happen in message-handler.js), so the test does not pollute live group buffers. Test pass rate should rise on the next overnight run; if any individual question still fails the rubric is now an honest signal.

### Commit `c08eb41 docs(architecture): update model/port boxes to current EVO topology`
Diagram boxes had Qwen3-VL-30B with overnight swap on 8080, classifier on 8081 (Qwen3-0.6B), nomic-embed on 8083. Reality (per `ss -tlnp` + each `/v1/models` endpoint, today): 8080 Qwen3.6-27B-Q6_K + spec-decode draft (always-on default chat), 8083 Qwen3-Embedding-8B-Q8_0, 8084 granite-docling-258M-f16, 8085 Qwen3-4B-Instruct-2507-Q4_K_M (planner), 8086 gemma-4-31B-it-Q4_K_M (NEW judge/2nd-opinion). The prose at lines 86-98 was already current; only the ASCII boxes lagged.

## P1 items downgraded after re-investigation

- **`src/lqcouncil/client.js` "dropped paths"** — FALSE POSITIVE. The client uses `baseUrl()` which always appends `/api`, so `request('GET', '/diag/health')` actually fetches `http://host:3100/api/diag/health` — and that path returns 200 OK. Yesterday's diagnostic curl'd without the `/api` prefix, got 404, and concluded the client was broken; the client was always correct. Verified today by hitting `/api/debates?limit=3` and `/api/bots` directly with the live admin token — both return 200 with full JSON.
- **WhatsApp decryption failures** — session-repair WORKS (journal shows `auto-repaired corrupted session — deleted session files` for jid 216131344289942 at May 5 05:58:25). Lost-mid-flight messages are unavoidable per the Signal protocol. Future messages succeed after repair. Not a bug to fix; consider an enhancement that DMs you "I think I missed something — try again" when a decrypt-fail spike happens, but that's a feature, not a fix.

## P2/P3 — most items either fixed or were stale-context false positives

- **CLAUDE.md "drift"** — actually current. The version I had in this worktree's branch (`claude/amazing-williams-b98bcb`, branched from `4d5ce2d`) was 50+ commits behind `main`, and I diffed against it. EVO's `CLAUDE.md` (on `origin/main`) already correctly says Qwen-default + MiniMax-fallback, classifier on 8085, no ambient agency. Nothing to update.
- **architecture.md** — diagram boxes updated (commit c08eb41). Prose was already current.
- **Three stale memory entries** — `project_lqcore_member_register.md` updated yesterday. The "/debate WIP-on-EVO" memory was already cleared by the live debate handler being committed back in April. The `project_lqc_api_drift_20260420.md` should be flipped from "still real" to "false alarm" — see the lqcouncil/client.js note above.
- **Swap saturation** — bot heap dropped from 287 MB → 123 MB on restart. Linux swap is sticky (doesn't auto-flush), still showing 1.8/2.0 GB used, but RAM has 9.0 GB available. No real pressure. Could `swapoff -a; swapon -a` if cosmetic, but risky during operation.
- **`/api/memory/list?category=X` filter ignored** — minor, deferred. Low traffic.
- **Codebase fragmentation on EVO** (3 copies of memory-service) — deferred, hygiene only.

## Final live state on EVO (2026-05-07 ~10:20 BST)

- All 21 dashboard API endpoints return 200 with the new token.
- Catch-all `/` returns 401 unauthed, 200 authed (no token leak in body for unauthed).
- All 5 local llama-server endpoints return 200 with correct model names.
- bot-council `/api/health|debates|bots` return 200.
- External `https://clawd.lqcouncil.com/` returns 404 (public exposure dead). `lqcouncil.com` still 200.
- All bot services active (`clawdbot`, `-memory`, `-voice`, `sovren-cloudflared`, `llama-server-main`, `llama-server-planner`, `bot-council`).
- Today's first successful dream report in 5+ weeks: `~/clawdbot-logs/overnight-report-2026-05-07.json` (3.2 KB).
- Today's overnight events log: 7 stages logged (consolidate/probe/report/operations).
- Triggered `POST /api/forge-now` to verify IMPROVE: groom returned `candidates:2, clusters:2, worse_drifts:0` (was 0/0/9 last Saturday). Synthesis was running at the time of writing — should produce non-empty output now that the timeout fix is live.
- Scheduler `overlapSkips: 0`, `lastTickMs: 2305ms`, only one `scheduler started` log line since restart (was 55 over 9 days pre-fix).

## Memory updates from this session

- Added: `project_checkup_2026_05_06.md` (yesterday's diagnostic).
- Updated: `project_lqcore_member_register.md` (code shipped + file populated, post-2026-04-19 status).
- Updated: `project_checkup_2026_05_07_fixes.md` (this file's mirror — 4 more commits + downgrades).
