#!/usr/bin/env python3
"""
evo-overnight/overnight-coder.py — Multi-round iterative coding with local 30B model.

Runs on PI, calls EVO coder model (Qwen3-Coder-30B-A3B, 64K ctx) via direct ethernet.
Implements Reflexion-style loops with observation masking and anchored summaries.

Schedule: 22:30 → 05:15 (started by overnight-coder.timer after model swap at 22:00)

Architecture (from SOTA research):
  - Reflexion loop: generate → execute → reflect → retry
  - Observation masking: last N rounds verbatim, older masked
  - Anchored iterative summary: structured sections, never regenerated
  - Mistake book: persistent catching-test memory across nights
  - White-box adversarial: model sees source when generating tests

Overnight schedule awareness:
  - 22:05-22:25: Dream mode uses :8080 → PAUSE if running
  - 01:50-02:20: Extraction + knowledge refresh use :8080 → PAUSE
  - 05:15: Hard stop (overnight report at 05:30, model swap at 06:00)

Hardening (2026-03-26):
  - Health check before starting — waits up to 60s for model to load
  - Per-round 300s timeout — prevents infinite hangs
  - Incremental results persistence — survives EVO crashes
  - EVO liveness check before each round — graceful exit if unreachable
  - Uses 30B non-GDN model (stable) instead of 80B GDN (crashed EVO)
"""

import json
import os
import subprocess
import sys
import time
import glob
import datetime
import argparse
import traceback
import socket

# ── Config ────────────────────────────────────────────────────────────────────

MODEL_URL = "http://10.0.0.2:8080/v1/chat/completions"  # EVO coder model (30B) via direct ethernet
EVO_HOST = "10.0.0.2"
EVO_SSH = "james@10.0.0.2"
HEALTH_URL = "http://10.0.0.2:8080/health"
REPO_DIR = os.path.expanduser("~/clawdbot")              # Pi repo path
DATA_DIR = os.path.join(REPO_DIR, "data")
RESULTS_DIR = os.path.join(REPO_DIR, "data", "overnight-results")

MAX_TOKENS = 8192         # Per-response token limit
TEMPERATURE = 0.3         # Low for code generation
VERBATIM_WINDOW = 3       # Keep last N rounds fully verbatim (reduced from 4 — saves context)
HARD_STOP_HOUR = 5        # Stop at 05:15 (before overnight report at 05:30)
HARD_STOP_MINUTE = 15
REQUEST_TIMEOUT = 300     # Per-request timeout in seconds (prevents infinite hangs)
MAX_CONSECUTIVE_FAILURES = 3  # Abort session after this many consecutive connection failures

# Circuit breaker state
_consecutive_failures = 0
_did_model_swap = False  # Track if we swapped model — ensures swap-back on any exit

# Code writing rules — injected into all prompts that generate or review code
CODE_RULES = """
## Code Writing Rules (BINDING)
- Max 300 lines per JS file, 500 per Python file. If a file exceeds, split it.
- One file, one job. If you need "and" to describe it, it's too much.
- No duplicate functions — search before writing. Import or extend, never copy.
- All EVO communication goes through evo-client.js. No file constructs its own HTTP to EVO.
- All constants in constants.js or config.js. Zero process.env outside config.js.
- Every catch block must log (logger.warn/error) or have a comment explaining silence.
- New scheduled tasks go in src/tasks/, not in scheduler.js.
- Clean up after yourself — delete old files when moving/replacing.
- Refactor violations when touching a file, not just add more code.
- src/tasks/ contains scheduled task modules (briefing, todo-reminders, meeting-alerts, etc.)
"""

# Time windows where other tasks use :8080 — pause during these
PAUSE_WINDOWS = [
    # Dream mode: 22:05-22:25 (but we start at 22:10, so just wait)
    # Extraction + knowledge refresh: ~02:00-02:20
    (1, 50, 2, 25),   # 01:50 → 02:25 (extraction + knowledge refresh buffer)
]

# ── HTTP Client ───────────────────────────────────────────────────────────────

try:
    import requests
except ImportError:
    import urllib.request

    class _FallbackRequests:
        @staticmethod
        def post(url, json=None, timeout=300):
            data = __import__('json').dumps(json).encode()
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
            resp = urllib.request.urlopen(req, timeout=timeout)
            body = __import__('json').loads(resp.read().decode())
            return type('R', (), {'json': lambda self: body, 'status_code': resp.status})()
    requests = _FallbackRequests()


def evo_is_reachable():
    """Quick TCP check — is EVO responding on port 8080?"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect((EVO_HOST, 8080))
        s.close()
        return True
    except (socket.timeout, ConnectionRefusedError, OSError):
        return False


def is_coder_model_active():
    """Check if the coder service is currently active on EVO."""
    try:
        result = subprocess.run(
            ["ssh", EVO_SSH, "systemctl is-active llama-server-coder.service"],
            capture_output=True, text=True, timeout=10
        )
        return result.stdout.strip() == "active"
    except Exception:
        return False


def swap_to_coder():
    """Swap EVO to coder model. Returns True if we swapped (and need to swap back)."""
    if is_coder_model_active():
        log("Coder model already active — no swap needed")
        return False
    log("Swapping EVO to coder model for coding session...")
    try:
        result = subprocess.run(
            ["ssh", EVO_SSH, "sudo /home/james/llama-swap-coder.sh"],
            capture_output=True, text=True, timeout=120
        )
        if result.returncode == 0:
            log("Coder model swap complete")
            return True
        else:
            log(f"Coder swap failed: {result.stderr.strip()}")
            return False
    except Exception as e:
        log(f"Coder swap error: {e}")
        return False


def swap_to_main():
    """Swap EVO back to daytime VL model."""
    log("Swapping EVO back to main VL model...")
    try:
        result = subprocess.run(
            ["ssh", EVO_SSH, "sudo /home/james/llama-swap-main.sh"],
            capture_output=True, text=True, timeout=120
        )
        if result.returncode == 0:
            log("Main model swap complete")
        else:
            log(f"Main swap failed: {result.stderr.strip()}")
    except Exception as e:
        log(f"Main swap error: {e}")


def wait_for_model(max_wait=60):
    """Wait up to max_wait seconds for the coder model to be healthy."""
    for i in range(max_wait // 5):
        try:
            resp = requests.post(HEALTH_URL if hasattr(requests, 'get') else MODEL_URL,
                                 json=None, timeout=5)
            return True
        except Exception as e:
            log(f"  Health check attempt {i+1} failed: {e}")
        # Fallback: just check TCP
        if evo_is_reachable():
            try:
                resp = requests.post(MODEL_URL, json={
                    "model": "qwen3-coder",
                    "messages": [{"role": "user", "content": "ping"}],
                    "max_tokens": 1,
                    "temperature": 0,
                    "stream": False,
                }, timeout=15)
                return True
            except Exception as e:
                log(f"  Model ping failed: {e}")
        time.sleep(5)
    return False


def save_incremental_results(results_data):
    """Write current results to disk — survives crashes."""
    path = os.path.join(RESULTS_DIR, f"overnight-partial-{datetime.date.today().isoformat()}.json")
    try:
        os.makedirs(RESULTS_DIR, exist_ok=True)
        with open(path, "w") as f:
            json.dump(results_data, f, indent=2)
    except Exception as e:
        log(f"  [WARN] Failed to save incremental results: {e}")


class EVOUnreachableError(Exception):
    """Raised when EVO has been unreachable for MAX_CONSECUTIVE_FAILURES attempts."""
    pass


def chat(messages, temperature=TEMPERATURE, max_tokens=MAX_TOKENS):
    """Send chat completion to local model. Returns content string.
    Tracks consecutive connection failures — raises EVOUnreachableError after 3."""
    global _consecutive_failures
    try:
        resp = requests.post(MODEL_URL, json={
            "model": "qwen3-coder",
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": False,
        }, timeout=REQUEST_TIMEOUT)
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        import re
        content = re.sub(r'<think>.*?</think>\s*', '', content, flags=re.DOTALL)
        _consecutive_failures = 0  # Reset on success
        return content.strip()
    except (ConnectionError, OSError, socket.timeout) as e:
        _consecutive_failures += 1
        log(f"  [ERROR] Chat failed ({_consecutive_failures}/{MAX_CONSECUTIVE_FAILURES}): {e}")
        if _consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
            raise EVOUnreachableError(f"EVO unreachable after {_consecutive_failures} consecutive failures")
        return f"[ERROR: {e}]"
    except Exception as e:
        log(f"  [ERROR] Chat failed: {e}")
        return f"[ERROR: {e}]"


# ── Utilities ─────────────────────────────────────────────────────────────────

session_log = []

def log(msg):
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    session_log.append(line)
    log_path = os.path.join(RESULTS_DIR, "overnight.log")
    with open(log_path, "a") as f:
        f.write(line + "\n")


_force_mode = False  # Set by --force flag to ignore time guards

def should_stop():
    """Check if we've hit the hard stop time (handles overnight wrap: 22:00→05:15)."""
    if _force_mode:
        return False
    now = datetime.datetime.now()
    h, m = now.hour, now.minute
    # We run from ~22:10 through midnight to 05:15
    # Stop only if hour is between HARD_STOP and start of evening window (05:15 → ~21:59)
    # i.e., stop if 05:15 ≤ now < 22:00
    now_mins = h * 60 + m
    stop_mins = HARD_STOP_HOUR * 60 + HARD_STOP_MINUTE
    start_mins = 22 * 60  # 22:00 evening start
    if stop_mins <= now_mins < start_mins:
        return True
    return False


def check_pause():
    """Pause if we're in a window where other tasks need the model."""
    now = datetime.datetime.now()
    for start_h, start_m, end_h, end_m in PAUSE_WINDOWS:
        start_mins = start_h * 60 + start_m
        end_mins = end_h * 60 + end_m
        now_mins = now.hour * 60 + now.minute
        if start_mins <= now_mins <= end_mins:
            wait_secs = (end_mins - now_mins) * 60 + 60  # +1 min buffer
            log(f"  PAUSE: Other tasks using model ({start_h:02d}:{start_m:02d}-{end_h:02d}:{end_m:02d}). Waiting {wait_secs//60} min...")
            time.sleep(wait_secs)
            log(f"  RESUME: Pause complete")
            return True
    return False


def read_file(rel_path):
    full = os.path.join(REPO_DIR, rel_path)
    if not os.path.exists(full):
        return f"[FILE NOT FOUND: {rel_path}]"
    with open(full, "r", errors="replace") as f:
        return f.read()


def run_cmd(cmd, cwd=REPO_DIR, timeout=60):
    try:
        result = subprocess.run(
            cmd, shell=True, cwd=cwd,
            capture_output=True, text=True, timeout=timeout
        )
        return (result.stdout + result.stderr).strip()
    except subprocess.TimeoutExpired:
        return "[TIMEOUT]"
    except Exception as e:
        return f"[ERROR: {e}]"


def read_all_src():
    src = {}
    # Read src/*.js
    for f in sorted(glob.glob(os.path.join(REPO_DIR, "src", "*.js"))):
        name = os.path.basename(f)
        with open(f, "r", errors="replace") as fh:
            src[name] = fh.read()
    # Read src/tasks/*.js
    for f in sorted(glob.glob(os.path.join(REPO_DIR, "src", "tasks", "*.js"))):
        name = "tasks/" + os.path.basename(f)
        with open(f, "r", errors="replace") as fh:
            src[name] = fh.read()
    return src


def read_data_sample(filename, max_lines=100):
    path = os.path.join(DATA_DIR, filename)
    if not os.path.exists(path):
        return f"[{filename} not found]"
    with open(path, "r", errors="replace") as f:
        lines = f.readlines()
    return "".join(lines[-max_lines:])


def write_file(rel_path, content):
    full = os.path.join(REPO_DIR, rel_path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(content)


def git_branch_and_commit(branch_name, message):
    run_cmd(f"git checkout -b {branch_name} 2>/dev/null || git checkout {branch_name}")
    run_cmd("git add -A")
    diff = run_cmd("git diff --cached --stat")
    if not diff or ("file changed" not in diff.lower() and "files changed" not in diff.lower()):
        return False
    run_cmd(f'git commit -m "{message}"')
    log(f"  Committed: {message}")
    return True


# ── Context Management ────────────────────────────────────────────────────────

class ConversationManager:
    """Observation masking + anchored iterative summary."""

    def __init__(self, system_prompt):
        self.system_prompt = system_prompt
        self.rounds = []
        self.anchored_summary = {
            "intent": "",
            "changes_made": [],
            "decisions": [],
            "issues_found": [],
            "next_steps": [],
        }

    def add_round(self, user_msg, assistant_msg):
        self.rounds.append((user_msg, assistant_msg))

    def update_summary(self, update_dict):
        for key in ["changes_made", "decisions", "issues_found", "next_steps"]:
            if key in update_dict and update_dict[key]:
                items = update_dict[key] if isinstance(update_dict[key], list) else [update_dict[key]]
                self.anchored_summary[key].extend(items)
        if "intent" in update_dict:
            self.anchored_summary["intent"] = update_dict["intent"]
        # Keep bounded
        for key in ["changes_made", "decisions", "issues_found"]:
            self.anchored_summary[key] = self.anchored_summary[key][-40:]
        self.anchored_summary["next_steps"] = self.anchored_summary["next_steps"][-10:]

    def build_messages(self):
        messages = [{"role": "system", "content": self.system_prompt}]

        if self.rounds:
            s = self.anchored_summary
            summary_text = "## Session State\n"
            summary_text += f"**Intent:** {s['intent']}\n"
            if s["changes_made"]:
                summary_text += f"**Changes ({len(s['changes_made'])}):** " + "; ".join(s["changes_made"][-15:]) + "\n"
            if s["decisions"]:
                summary_text += f"**Decisions:** " + "; ".join(s["decisions"][-10:]) + "\n"
            if s["issues_found"]:
                summary_text += f"**Issues ({len(s['issues_found'])}):** " + "; ".join(s["issues_found"][-15:]) + "\n"
            if s["next_steps"]:
                summary_text += f"**Next:** " + "; ".join(s["next_steps"][-5:]) + "\n"
            messages.append({"role": "user", "content": summary_text})
            messages.append({"role": "assistant", "content": "Session state loaded. Continuing."})

        n = len(self.rounds)
        for i, (user_msg, assistant_msg) in enumerate(self.rounds):
            messages.append({"role": "user", "content": user_msg})
            if i >= n - VERBATIM_WINDOW:
                messages.append({"role": "assistant", "content": assistant_msg})
            else:
                preview = assistant_msg[:300] + "..." if len(assistant_msg) > 300 else assistant_msg
                messages.append({"role": "assistant", "content": f"[Round {i+1} output omitted. Preview: {preview}]"})

        return messages

    def chat_round(self, user_msg, temperature=TEMPERATURE, max_tokens=MAX_TOKENS):
        check_pause()
        if should_stop():
            return "[HARD STOP — time limit reached]"
        msgs = self.build_messages()
        msgs.append({"role": "user", "content": user_msg})
        response = chat(msgs, temperature=temperature, max_tokens=max_tokens)
        self.add_round(user_msg, response)
        return response


# ── Task 1: Router Eval Adversarial Expansion ─────────────────────────────────

def task_router_eval(src_files):
    """Adversarial expansion of the router eval suite. Runs until time budget or diminishing returns."""
    log("=" * 50)
    log("=== TASK 1: Router Eval Adversarial Expansion ===")
    log("=" * 50)

    branch = f"overnight-eval-{datetime.date.today().isoformat()}"
    run_cmd(f"git checkout main 2>/dev/null; git checkout -b {branch} 2>/dev/null || git checkout {branch}")

    router_src = src_files.get("router.js", "")
    eval_src = read_file("eval/router-eval.js")
    definitions_src = src_files.get("definitions.js", "")
    telemetry = read_data_sample("router-stats.jsonl", 150)
    feedback = read_data_sample("feedback.jsonl", 50)
    interactions = read_data_sample("interactions.jsonl", 80)
    learned_rules = read_file("data/learned-rules.json") if os.path.exists(os.path.join(DATA_DIR, "learned-rules.json")) else "{}"

    system_prompt = f"""You are an expert code analyst hardening Clawdbot's message router through adversarial testing.

GOAL: Find and document misclassifications in the keyword router by generating tricky test messages.

METHODOLOGY (Reflexion + Adversarial):
Each round:
1. Identify a specific GAP not yet tested
2. Generate 15-20 adversarial messages targeting that gap
3. State EXPECTED classification for each
4. After seeing results, REFLECT on what the misclassifications reveal

OUTPUT FORMAT (strict JSON):
```json
{{
  "gap_identified": "description",
  "gap_category": "which CATEGORY or cross-category confusion",
  "test_cases": [
    {{"msg": "test message", "expected": "CATEGORY_NAME", "reason": "why tricky"}}
  ],
  "proposed_rules": [
    {{"pattern": "keyword/regex", "category": "CATEGORY", "rationale": "why"}}
  ]
}}
```

ANTI-MODE-COLLAPSE — each round MUST vary:
- Target different categories and cross-category boundaries
- Mix styles: formal, casual, typos, abbreviations, multi-intent, negated
- Include messages that should be SILENT or GENERAL (not everything is a tool call)
- Test: very short (2-3 words), medium, and long messages
- Test: questions vs statements vs commands
- Test: messages about Clawd vs messages for Clawd
- Test: messages with misleading keywords (e.g., "train of thought" ≠ TRAVEL)

CATEGORIES: {', '.join(c for c in dir() if c.isupper())}

## router.js
```javascript
{router_src}
```

## definitions.js
```javascript
{definitions_src}
```

## Current eval suite ({eval_src.count('msg:') + eval_src.count('"msg"')} approx cases)
```javascript
{eval_src}
```

## Learned rules
```json
{learned_rules}
```"""

    conv = ConversationManager(system_prompt)
    conv.update_summary({"intent": "Expand router eval suite with adversarial test cases, find misclassifications"})

    # Load persistent mistake book
    mistake_book_path = os.path.join(RESULTS_DIR, "mistake-book.json")
    if os.path.exists(mistake_book_path):
        with open(mistake_book_path) as f:
            mistake_book = json.load(f)
    else:
        mistake_book = {"catching_tests": [], "total_misclassifications": 0, "sessions": []}

    all_new_labels = []
    all_proposed_rules = []
    all_misclassifications = []
    rounds_with_no_finds = 0
    round_num = 0

    while not should_stop():
        round_num += 1

        # Diminishing returns check — stop after 3 consecutive rounds with 0 misclassifications
        if rounds_with_no_finds >= 3:
            log(f"  3 consecutive rounds with no misclassifications — moving on")
            break

        # EVO liveness check before each round
        if not evo_is_reachable():
            log(f"  EVO unreachable at {EVO_HOST} — saving results and exiting")
            break

        log(f"  Round {round_num}")
        check_pause()
        if should_stop():
            break

        covered_gaps = [r.get("gap_identified", "") for _, r in enumerate(all_new_labels) if isinstance(r, dict)]
        covered_cats = list(set(t.get("expected", "") for t in all_new_labels[-60:]))

        round_prompt = f"""## Round {round_num}

Stats so far: {len(all_new_labels)} test labels generated, {len(all_misclassifications)} misclassifications found across {round_num-1} rounds.

Categories well-covered in previous rounds: {', '.join(covered_cats) if covered_cats else 'none yet'}
Pick a DIFFERENT category or cross-category boundary this round.

Telemetry (last 150 routing decisions):
{telemetry[:4000]}

Feedback:
{feedback[:2000]}

Interactions sample:
{interactions[:2000]}

Mistake book ({len(mistake_book['catching_tests'])} historical catches):
{json.dumps(mistake_book['catching_tests'][-15:], indent=2) if mistake_book['catching_tests'] else '[]'}

Output strict JSON only."""

        response = conv.chat_round(round_prompt)
        if "[HARD STOP" in response or "[ERROR" in response:
            break

        try:
            json_str = response
            if "```json" in json_str:
                json_str = json_str.split("```json")[1].split("```")[0]
            elif "```" in json_str:
                json_str = json_str.split("```")[1].split("```")[0]

            parsed = json.loads(json_str.strip())
            test_cases = parsed.get("test_cases", [])
            proposed_rules = parsed.get("proposed_rules", [])
            gap = parsed.get("gap_identified", "unknown")

            log(f"    Gap: {gap[:80]}")
            log(f"    Generated {len(test_cases)} tests, {len(proposed_rules)} rules")

            # Run through actual router
            validation_script = "const r = await import('./src/router.js');\n"
            for i, tc in enumerate(test_cases[:20]):
                msg = tc.get("msg", "").replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ")
                validation_script += f"console.log(JSON.stringify({{i:{i}, result: r.classifyByKeywords('{msg}')}}));\n"

            write_file("_eval_tmp.mjs", validation_script)
            output = run_cmd("node --env-file=.env _eval_tmp.mjs 2>&1", timeout=30)
            run_cmd("rm -f _eval_tmp.mjs")

            misclassifications = []
            for line in output.strip().split("\n"):
                try:
                    r = json.loads(line)
                    idx = r["i"]
                    actual = r["result"]
                    if idx < len(test_cases):
                        expected = test_cases[idx].get("expected", "").upper()
                        test_cases[idx]["actual"] = actual
                        if actual is not None and actual.upper() != expected:
                            mc = {
                                "msg": test_cases[idx]["msg"],
                                "expected": expected,
                                "actual": actual,
                                "reason": test_cases[idx].get("reason", ""),
                                "round": round_num,
                            }
                            misclassifications.append(mc)
                        elif actual is None and expected != "NONE" and expected != "NULL":
                            # No keyword match — expected something but got null
                            mc = {
                                "msg": test_cases[idx]["msg"],
                                "expected": expected,
                                "actual": "null (no keyword match)",
                                "reason": test_cases[idx].get("reason", ""),
                                "round": round_num,
                            }
                            misclassifications.append(mc)
                except (json.JSONDecodeError, KeyError):
                    continue

            log(f"    Misclassifications: {len(misclassifications)}")

            if misclassifications:
                rounds_with_no_finds = 0
                all_misclassifications.extend(misclassifications)
                mistake_book["catching_tests"].extend(misclassifications)
                mistake_book["total_misclassifications"] += len(misclassifications)
            else:
                rounds_with_no_finds += 1

            # Collect all labels
            for tc in test_cases:
                all_new_labels.append({
                    "msg": tc.get("msg", ""),
                    "expected": tc.get("expected", ""),
                    "actual": tc.get("actual"),
                    "round": round_num,
                    "gap": gap[:50],
                })

            all_proposed_rules.extend(proposed_rules)

            conv.update_summary({
                "issues_found": [f"R{round_num}: {len(misclassifications)} misclass in '{gap[:40]}'"],
                "changes_made": [f"R{round_num}: {len(test_cases)} tests ({gap[:30]})"],
            })

            # Reflection round (only if misclassifications found — saves time)
            if misclassifications:
                refl_prompt = f"""## Reflection on Round {round_num}

{len(misclassifications)} misclassifications found:
{json.dumps(misclassifications[:8], indent=2)}

Analyze briefly (2-3 sentences):
1. What pattern do they share?
2. What single keyword rule would fix the most?
3. What gap should the next round target?"""

                refl = conv.chat_round(refl_prompt, max_tokens=1024)
                if "[HARD STOP" not in refl:
                    log(f"    Reflected ({len(refl)} chars)")

            # Incremental save after each successful round
            save_incremental_results({
                "task": "router-eval-expansion",
                "generated": datetime.datetime.now().isoformat(),
                "rounds_completed": round_num,
                "total_labels": len(all_new_labels),
                "total_misclassifications": len(all_misclassifications),
                "labels": all_new_labels,
                "misclassifications": all_misclassifications,
                "proposed_rules": all_proposed_rules,
                "status": "in_progress",
            })

        except (json.JSONDecodeError, KeyError, IndexError) as e:
            log(f"    Parse error: {e}")
            continue

    # Write results
    log(f"  Router eval complete: {round_num} rounds, {len(all_new_labels)} labels, {len(all_misclassifications)} misclassifications")

    write_file("data/overnight-eval-labels.json", json.dumps({
        "generated": datetime.datetime.now().isoformat(),
        "total_labels": len(all_new_labels),
        "total_misclassifications": len(all_misclassifications),
        "rounds": round_num,
        "labels": all_new_labels,
        "misclassifications": all_misclassifications,
        "proposed_rules": all_proposed_rules,
    }, indent=2))

    # Save mistake book
    mistake_book["sessions"].append({
        "date": datetime.date.today().isoformat(),
        "rounds": round_num,
        "misclassifications": len(all_misclassifications),
        "labels": len(all_new_labels),
    })
    with open(mistake_book_path, "w") as f:
        json.dump(mistake_book, f, indent=2)

    # Run full eval suite
    eval_output = run_cmd("node --env-file=.env eval/router-eval.js 2>&1", timeout=60)
    log(f"  Eval baseline:\n{eval_output[-600:]}")

    committed = git_branch_and_commit(branch, f"overnight: router eval ({len(all_new_labels)} labels, {len(all_misclassifications)} misclass, {len(all_proposed_rules)} rules)")

    return {
        "task": "router-eval-expansion",
        "rounds": round_num,
        "new_labels": len(all_new_labels),
        "misclassifications": len(all_misclassifications),
        "proposed_rules": len(all_proposed_rules),
        "branch": branch if committed else None,
        "eval_output": eval_output[-600:],
        "top_misclassifications": all_misclassifications[:20],
        "top_rules": all_proposed_rules[:15],
    }


# ── Task 2: Unit Test Generation (LLMLOOP) ───────────────────────────────────

def task_unit_tests(src_files):
    """Generate unit tests for all testable modules. Iterates until passing or round limit."""
    log("=" * 50)
    log("=== TASK 2: Unit Test Generation (LLMLOOP) ===")
    log("=" * 50)

    branch = f"overnight-tests-{datetime.date.today().isoformat()}"
    run_cmd(f"git checkout main 2>/dev/null; git checkout -b {branch} 2>/dev/null || git checkout {branch}")

    # All modules worth testing, ordered by testability (pure functions first)
    targets = [
        # Core routing & classification
        ("router.js", "Keyword classification, complexity detection, write-intent, category config"),
        ("trigger.js", "Trigger detection: DM, mention, prefix, random chance, passive mode"),
        ("engagement.js", "Engagement scoring, cooldown tracking, mute system, bot-name detection"),
        # Message handling pipeline
        ("message-handler.js", "Message routing, document detection, image handling, dedup"),
        ("document-handler.js", "PDF/DOCX parsing, EVO summarisation, document storage"),
        ("message-cache.js", "Sent message cache, getMessage callback, TTL management"),
        # Knowledge & memory
        ("lquorum-rag.js", "Keyword scanning, topic matching, working memory cache, decay logic"),
        ("memory.js", "Memory search, cache sync, EVO health checks, queue management"),
        ("system-knowledge.js", "System self-awareness, knowledge injection"),
        # Prompt & response
        ("prompt.js", "System prompt construction, context building, self-awareness injection"),
        ("quality-gate.js", "Opus critique, anti-slop rewrite, response quality gating"),
        # Infrastructure
        ("constants.js", "Shared constants: timeouts, ports, URLs, buffer sizes, cooldowns"),
        ("evo-client.js", "Centralised EVO HTTP client, circuit breaker, health checks"),
        ("circuit-breaker.js", "Circuit breaker pattern: open/closed/half-open states"),
        ("usage-tracker.js", "Token usage tracking, cost estimation, rate limiting"),
        ("session-repair.js", "Baileys session repair, decryption failure detection"),
        # Data & logging
        ("interaction-log.js", "JSONL logging, feedback parsing, reaction tracking"),
        ("conversation-logger.js", "Group conversation logging for dream mode"),
        ("widgets.js", "Widget cache, data freshness, calendar parsing, email triage"),
        # Evolution & overnight
        ("evolution-gate.js", "Evolution task validation, scope checking, approval flow"),
        ("overnight-report.js", "Report generation, data collection, formatting"),
        # Scheduled tasks (src/tasks/)
        ("tasks/briefing.js", "Morning briefing generation, calendar/email/todo summary"),
        ("tasks/todo-reminders.js", "Todo reminder scheduling, due date checking"),
        ("tasks/meeting-alerts.js", "Side gig meeting detection, upcoming meeting alerts"),
    ]

    # Build codebase context (concise — signatures + key exports)
    codebase_map = "## Codebase Map (src/*.js + src/tasks/*.js)\n"
    for name, content in sorted(src_files.items()):
        # Extract exports and function signatures
        lines = content.split("\n")
        exports = [l.strip() for l in lines if l.strip().startswith("export ")]
        funcs = [l.strip() for l in lines if "function " in l and not l.strip().startswith("//")][:10]
        codebase_map += f"\n### {name} ({len(lines)} lines)\n"
        if exports:
            codebase_map += "Exports: " + "; ".join(exports[:15]) + "\n"
        if funcs:
            codebase_map += "Functions: " + "; ".join(funcs[:10]) + "\n"

    all_results = []

    for module_name, module_desc in targets:
        if should_stop():
            log(f"  Time limit — stopping unit tests")
            break
        check_pause()

        log(f"  --- Module: {module_name} ---")

        module_src = src_files.get(module_name, "[not found]")
        if module_src == "[not found]":
            log(f"    Skipping: not found")
            continue

        max_rounds = 6

        # Handle tasks/ subdirectory in import paths
        if module_name.startswith("tasks/"):
            import_path = f"../src/{module_name}"
            test_file_name = f"test-{module_name.replace('tasks/', 'task-').replace('.js', '')}.mjs"
        else:
            import_path = f"../src/{module_name}"
            test_file_name = f"test-{module_name.replace('.js', '')}.mjs"
        test_file = f"eval/{test_file_name}"

        system_prompt = f"""You are an expert JavaScript test engineer. Write comprehensive unit tests.

RULES:
- Node.js 22, ESM modules ("type": "module"), NO test framework — use node:test and node:assert
- Tests run with: node --env-file=.env {test_file}
- Set process.env.ANTHROPIC_API_KEY = 'test-placeholder' BEFORE any imports
- Use dynamic imports: const mod = await import('{import_path}')
- Only test actually-exported functions
- Mock ALL network calls (fetch, http) — tests must run 100% offline
- Mock file system operations if needed
- Each test must be independent (no shared mutable state)
- Output ONLY the file content — no markdown fences, no explanations

COVERAGE TARGETS:
- Happy paths for every exported function
- Edge cases: empty input, null, undefined, very long strings
- Error handling: what happens when dependencies fail?
- Boundary values: 0, 1, max values
- Type coercion traps (JavaScript-specific)
{CODE_RULES}
{codebase_map}

## Module Under Test: {module_name}
{module_desc}

```javascript
{module_src}
```"""

        conv = ConversationManager(system_prompt)
        conv.update_summary({"intent": f"Generate tests for {module_name}"})

        result = {"module": module_name, "rounds": 0, "final_pass": False, "tests_count": 0, "last_error": ""}

        for round_num in range(1, max_rounds + 1):
            if should_stop():
                break

            log(f"    Round {round_num}/{max_rounds}")

            if round_num == 1:
                prompt = f"""Generate a comprehensive test file for {module_name}.
Focus on exported functions. Use node:test (describe/it/test) and node:assert.
Set process.env.ANTHROPIC_API_KEY = 'test-placeholder' as the FIRST line.
Use dynamic imports. Mock network calls.
Output ONLY the file content."""
            else:
                prompt = f"""Previous run result:
```
{last_output[:4000]}
```

{'SYNTAX ERROR — fix the JavaScript syntax.' if 'SyntaxError' in last_output else ''}
{'IMPORT ERROR — check what the module actually exports. Only test exported functions.' if 'not a function' in last_output or 'is not defined' in last_output else ''}
{'MODULE ERROR — the import path or export name is wrong.' if 'Cannot find module' in last_output or 'does not provide' in last_output else ''}

Fix the issues. Output the COMPLETE test file, not a patch."""

            response = conv.chat_round(prompt, max_tokens=MAX_TOKENS)
            if "[HARD STOP" in response:
                break

            # Clean markdown fences
            content = response
            if content.startswith("```"):
                lines = content.split("\n")
                content = "\n".join(lines[1:])
                if content.rstrip().endswith("```"):
                    content = content.rstrip()[:-3]

            write_file(test_file, content)

            # Syntax check
            syntax = run_cmd(f"node --check {test_file} 2>&1", timeout=10)
            if syntax and "SyntaxError" in syntax:
                last_output = syntax
                log(f"    Syntax error")
                result["last_error"] = "syntax"
                continue

            # Run tests
            last_output = run_cmd(f"node --env-file=.env {test_file} 2>&1", timeout=45)
            log(f"    Output ({len(last_output)} chars): ...{last_output[-150:]}")

            has_output = len(last_output.strip()) > 20

            # Parse node:test TAP output for pass/fail counts
            import re
            fail_match = re.search(r'# fail (\d+)', last_output)
            pass_match = re.search(r'# pass (\d+)', last_output)
            fail_count = int(fail_match.group(1)) if fail_match else -1
            pass_count = int(pass_match.group(1)) if pass_match else 0

            # If TAP output present, use structured counts
            if fail_match is not None:
                has_failures = fail_count > 0
            else:
                # Fallback: check for error keywords (no TAP output = crash/import error)
                has_failures = any(kw in last_output.lower() for kw in [
                    "syntaxerror", "referenceerror", "typeerror", "is not a function",
                    "does not provide", "unexpected token", "not defined",
                    "cannot find module", "err_module_not_found",
                ])

            if has_output and not has_failures:
                # Count tests from TAP output (more reliable than counting source)
                test_count = pass_count if pass_count > 0 else content.count("test(") + content.count("it(")
                result["final_pass"] = True
                result["tests_count"] = test_count
                result["rounds"] = round_num
                log(f"    PASS — {test_count} tests")
                break
            else:
                result["last_error"] = last_output[-200:]
                result["rounds"] = round_num

        all_results.append(result)

    passing = [r for r in all_results if r["final_pass"]]
    failing = [r for r in all_results if not r["final_pass"]]
    total_tests = sum(r["tests_count"] for r in passing)

    log(f"  Unit tests complete: {len(passing)}/{len(all_results)} modules passing, {total_tests} total tests")

    committed = git_branch_and_commit(branch,
        f"overnight: unit tests ({total_tests} tests, {len(passing)}/{len(all_results)} modules passing)")

    return {
        "task": "unit-test-generation",
        "modules_passing": len(passing),
        "modules_total": len(all_results),
        "total_tests": total_tests,
        "branch": branch if committed else None,
        "details": all_results,
    }


# ── Task 3: Code Quality Analysis ────────────────────────────────────────────

def task_code_quality(src_files):
    """Deep code quality analysis — find bugs, dead code, inconsistencies, improvements."""
    log("=" * 50)
    log("=== TASK 3: Code Quality Deep Analysis ===")
    log("=" * 50)

    if should_stop():
        return {"task": "code-quality", "skipped": True}

    # Feed entire codebase to the model in one shot (within 128K)
    full_codebase = ""
    for name in sorted(src_files.keys()):
        full_codebase += f"\n{'='*60}\n## {name}\n{'='*60}\n{src_files[name]}\n"

    system_prompt = f"""You are a senior JavaScript code reviewer doing an exhaustive quality audit.

This is the complete source of a Node.js WhatsApp bot (ESM, no TypeScript).
Analyze every file systematically.

## Project Structure
- src/*.js — core modules (max 300 lines each)
- src/tasks/*.js — scheduled task modules (briefing, reminders, meeting alerts, etc.)
- data/ — JSON data files, logs, overnight results
- test/ — unit tests
{CODE_RULES}
{full_codebase}"""

    conv = ConversationManager(system_prompt)

    analyses = []

    # Round 1: Bug hunt
    if not should_stop():
        log(f"  Phase 1: Bug Hunt")
        r = conv.chat_round("""Scan every file for BUGS — not style issues, actual bugs that could cause runtime errors, data loss, or incorrect behavior.

For each bug found:
- File and approximate location
- What the bug is
- Severity (critical/high/medium/low)
- Suggested fix (one line)

Output as JSON array:
```json
[{"file": "x.js", "location": "description", "bug": "what", "severity": "high", "fix": "how"}]
```""", max_tokens=MAX_TOKENS)
        analyses.append(("bugs", r))
        log(f"    Bug hunt complete ({len(r)} chars)")

    # Round 2: Dead code / unused exports
    if not should_stop():
        log(f"  Phase 2: Dead Code Detection")
        r = conv.chat_round("""Now scan for DEAD CODE:
- Functions defined but never called (from any file)
- Exports never imported by any other file
- Variables assigned but never read
- Unreachable code paths (after returns, impossible conditions)
- Config values defined but never used

Output as JSON:
```json
[{"file": "x.js", "item": "functionName", "type": "unused_export|dead_function|unreachable|unused_var", "confidence": "high|medium"}]
```""", max_tokens=MAX_TOKENS)
        analyses.append(("dead_code", r))
        log(f"    Dead code scan complete ({len(r)} chars)")

    # Round 3: Error handling gaps
    if not should_stop():
        log(f"  Phase 3: Error Handling Gaps")
        r = conv.chat_round("""Scan for ERROR HANDLING GAPS:
- Async functions without try/catch
- Promise chains without .catch()
- Network calls (fetch, API) without timeout or error handling
- File operations without existence checks
- JSON.parse without try/catch
- Array access without bounds checking on external data

Output as JSON:
```json
[{"file": "x.js", "location": "description", "gap": "what's missing", "risk": "what could happen"}]
```""", max_tokens=MAX_TOKENS)
        analyses.append(("error_handling", r))
        log(f"    Error handling scan complete ({len(r)} chars)")

    # Round 4: Performance issues
    if not should_stop():
        log(f"  Phase 4: Performance Issues")
        r = conv.chat_round("""Scan for PERFORMANCE issues:
- Unnecessary re-reads of files that could be cached
- O(n²) or worse loops on data that could grow
- Blocking operations in the event loop
- Memory leaks (growing arrays/maps without bounds)
- Redundant API calls
- Large string concatenation in loops

Output as JSON:
```json
[{"file": "x.js", "location": "description", "issue": "what", "impact": "high|medium|low", "fix": "suggestion"}]
```""", max_tokens=MAX_TOKENS)
        analyses.append(("performance", r))
        log(f"    Performance scan complete ({len(r)} chars)")

    # Round 5: Security review
    if not should_stop():
        log(f"  Phase 5: Security Review")
        r = conv.chat_round("""Final pass: SECURITY review.
- Injection risks (SQL, command, template)
- Secrets in code (API keys, tokens, passwords hardcoded)
- Path traversal risks in file operations
- Unvalidated external input used in sensitive operations
- SSRF risks in URL handling
- Auth bypass possibilities

Output as JSON:
```json
[{"file": "x.js", "location": "description", "vulnerability": "what", "severity": "critical|high|medium", "fix": "suggestion"}]
```""", max_tokens=MAX_TOKENS)
        analyses.append(("security", r))
        log(f"    Security review complete ({len(r)} chars)")

    # Round 6: Code structure rules compliance
    if not should_stop():
        log(f"  Phase 6: Structure Rules Compliance")
        r = conv.chat_round(f"""Check compliance with the project's code structure rules:
{CODE_RULES}
For each violation found:
- File and what rule it breaks
- Severity (high if actively harmful, medium if tech debt)
- Whether it's fixable without changing behavior

Output as JSON:
```json
[{{"file": "x.js", "rule": "which rule", "violation": "what", "severity": "high|medium", "fixable": true}}]
```""", max_tokens=MAX_TOKENS)
        analyses.append(("structure_rules", r))
        log(f"    Structure rules check complete ({len(r)} chars)")

    # Parse and aggregate
    all_findings = {}
    for category, raw in analyses:
        try:
            json_str = raw
            if "```json" in json_str:
                json_str = json_str.split("```json")[1].split("```")[0]
            elif "```" in json_str:
                json_str = json_str.split("```")[1].split("```")[0]
            findings = json.loads(json_str.strip())
            all_findings[category] = findings
            log(f"    {category}: {len(findings)} findings")
        except (json.JSONDecodeError, ValueError):
            all_findings[category] = raw[:500]
            log(f"    {category}: could not parse JSON")

    # Write analysis
    write_file("data/overnight-results/code-quality.json", json.dumps({
        "date": datetime.datetime.now().isoformat(),
        "findings": all_findings,
    }, indent=2))

    total_findings = sum(len(v) for v in all_findings.values() if isinstance(v, list))
    log(f"  Code quality complete: {total_findings} findings across {len(analyses)} phases")

    return {
        "task": "code-quality",
        "phases": len(analyses),
        "findings": {k: len(v) if isinstance(v, list) else "parse_error" for k, v in all_findings.items()},
        "total_findings": total_findings,
    }


# ── Morning Briefing Report ──────────────────────────────────────────────────

def write_morning_report(results, elapsed):
    """Write comprehensive morning briefing."""
    date = datetime.date.today().isoformat()
    report_path = os.path.join(RESULTS_DIR, f"briefing-{date}.md")

    with open(report_path, "w") as f:
        f.write(f"# Overnight Coding Report — {date}\n\n")
        f.write(f"**Duration:** {round(elapsed/60)} minutes | ")
        f.write(f"**Model:** Qwen3-Coder-30B-A3B Q4_K_M (64K ctx, non-GDN, stable) | ")
        f.write(f"**Tasks:** {len(results)}\n\n")
        f.write("---\n\n")

        for r in results:
            task = r.get("task", "unknown")

            if task == "router-eval-expansion":
                f.write("## 1. Router Eval Adversarial Expansion\n\n")
                f.write(f"| Metric | Value |\n|--------|-------|\n")
                f.write(f"| Rounds | {r.get('rounds', '?')} |\n")
                f.write(f"| Test labels generated | {r.get('new_labels', 0)} |\n")
                f.write(f"| **Misclassifications found** | **{r.get('misclassifications', 0)}** |\n")
                f.write(f"| Proposed keyword rules | {r.get('proposed_rules', 0)} |\n")
                f.write(f"| Branch | `{r.get('branch', 'none')}` |\n\n")

                if r.get("top_misclassifications"):
                    f.write("### Top Misclassifications\n\n")
                    f.write("| Message | Expected | Actual | Reason |\n")
                    f.write("|---------|----------|--------|--------|\n")
                    for mc in r["top_misclassifications"][:15]:
                        msg = mc.get("msg", "")[:50].replace("|", "\\|")
                        f.write(f"| {msg} | {mc.get('expected','')} | {mc.get('actual','')} | {mc.get('reason','')[:40]} |\n")
                    f.write("\n")

                if r.get("top_rules"):
                    f.write("### Proposed Keyword Rules\n\n")
                    for rule in r["top_rules"][:10]:
                        f.write(f"- `{rule.get('pattern','')}` → {rule.get('category','')} — {rule.get('rationale','')}\n")
                    f.write("\n")

                if r.get("eval_output"):
                    f.write(f"### Current Eval Baseline\n```\n{r['eval_output']}\n```\n\n")

            elif task == "unit-test-generation":
                f.write("## 2. Unit Test Generation\n\n")
                f.write(f"**{r.get('modules_passing', 0)}/{r.get('modules_total', 0)} modules passing** | ")
                f.write(f"**{r.get('total_tests', 0)} total tests** | ")
                f.write(f"Branch: `{r.get('branch', 'none')}`\n\n")

                if r.get("details"):
                    f.write("| Module | Status | Tests | Rounds | Notes |\n")
                    f.write("|--------|--------|-------|--------|-------|\n")
                    for m in r["details"]:
                        status = "PASS" if m.get("final_pass") else "FAIL"
                        emoji = "+" if m.get("final_pass") else "-"
                        error = m.get("last_error", "")[:40].replace("|", "\\|") if not m.get("final_pass") else ""
                        f.write(f"| {m['module']} | {status} | {m.get('tests_count', 0)} | {m.get('rounds', 0)} | {error} |\n")
                    f.write("\n")

            elif task == "code-quality":
                f.write("## 3. Code Quality Deep Analysis\n\n")
                if r.get("skipped"):
                    f.write("*Skipped — time limit reached*\n\n")
                else:
                    f.write(f"**{r.get('total_findings', 0)} findings** across {r.get('phases', 0)} phases\n\n")
                    if r.get("findings"):
                        f.write("| Phase | Findings |\n|-------|----------|\n")
                        for phase, count in r["findings"].items():
                            f.write(f"| {phase} | {count} |\n")
                        f.write("\n")
                    f.write(f"Full details: `data/overnight-results/code-quality.json`\n\n")

            elif "error" in r:
                f.write(f"## Error\n\n**{r['error']}**\n\n")

        f.write("---\n\n")
        f.write("*Review branches with:*\n")
        for r in results:
            if r.get("branch"):
                f.write(f"- `cd ~/clawdbot && git log --oneline main..{r['branch']}`\n")
        f.write(f"\n*Full log: `data/overnight-results/overnight.log`*\n")
        f.write(f"\n*Generated by overnight-coder.py using local Qwen3-Coder-30B-A3B*\n")

    log(f"Morning report: {report_path}")
    return report_path


# ── Opus Post-Review ─────────────────────────────────────────────────────────

def opus_post_review(results, briefing_path):
    """Send overnight results to Claude Opus 4.6 for a single-pass quality review.

    Reads the briefing + any branch diffs, sends to Opus via Anthropic API,
    appends the review to the briefing file. Requires ANTHROPIC_API_KEY in env.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        log("Opus review: ANTHROPIC_API_KEY not set — skipping")
        return None

    log("=" * 60)
    log("OPUS POST-REVIEW — Sending overnight results to Claude Opus 4.6")
    log("=" * 60)

    # Collect branch diffs from EVO
    branch_diffs = {}
    for r in results:
        branch = r.get("branch")
        if branch:
            try:
                diff_output = subprocess.run(
                    ["ssh", "james@10.0.0.2",
                     f"cd ~/clawdbot-claude-code && git diff main...{branch} 2>/dev/null | head -2000"],
                    capture_output=True, text=True, timeout=30
                ).stdout.strip()
                if diff_output:
                    branch_diffs[branch] = diff_output
            except Exception as e:
                log(f"  Failed to get diff for {branch}: {e}")

    # Read the briefing
    briefing_text = ""
    try:
        with open(briefing_path) as f:
            briefing_text = f.read()
    except Exception as e:
        log(f"  [WARN] Could not read briefing file: {e}")

    # Build review prompt
    review_content = f"""# Overnight Coding Session Results

## Briefing
{briefing_text}

## Summary Data
{json.dumps(results, indent=2)[:8000]}
"""

    for branch, diff in branch_diffs.items():
        review_content += f"\n## Branch: {branch}\n```diff\n{diff[:4000]}\n```\n"

    review_prompt = """Review this overnight automated coding session output. The code was generated by a local 30B model (Qwen3-Coder-30B-A3B) running on an AMD GPU.

Assess:
1. **Code quality** — Are the generated tests/rules/fixes correct? Any obvious bugs, logic errors, or bad patterns?
2. **Safety** — Anything that could break production if deployed? Missing error handling? Unsafe operations?
3. **Completeness** — Were the right things tested? Any glaring gaps?
4. **Verdict** — For each branch/change: APPROVE (safe to merge), NEEDS WORK (specific issues), or REJECT (fundamentally wrong).

Be direct and specific. No filler. If everything looks fine, say so briefly."""

    # Call Opus via Anthropic API
    try:
        import urllib.request
        import urllib.error

        payload = json.dumps({
            "model": "claude-opus-4-6",
            "max_tokens": 4096,
            "messages": [
                {"role": "user", "content": review_content}
            ],
            "system": review_prompt,
        }).encode()

        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
        )

        resp = urllib.request.urlopen(req, timeout=120)
        body = json.loads(resp.read().decode())
        review_text = body.get("content", [{}])[0].get("text", "")

        if not review_text:
            log("Opus review: empty response")
            return None

        # Append to briefing
        with open(briefing_path, "a") as f:
            f.write("\n\n---\n\n## Opus 4.6 Post-Review\n\n")
            f.write(review_text)
            f.write("\n\n*Reviewed by Claude Opus 4.6*\n")

        log(f"Opus review complete — {len(review_text)} chars appended to briefing")

        # Also save standalone
        review_path = os.path.join(RESULTS_DIR, f"opus-review-{datetime.date.today().isoformat()}.md")
        with open(review_path, "w") as f:
            f.write(f"# Opus Post-Review — {datetime.date.today().isoformat()}\n\n")
            f.write(review_text)

        return review_text

    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if hasattr(e, 'read') else str(e)
        log(f"Opus review failed: HTTP {e.code} — {error_body[:200]}")
        return None
    except Exception as e:
        log(f"Opus review failed: {e}")
        return None


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    global _force_mode
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", choices=["router-eval", "unit-tests", "code-quality", "all"], default="all")
    parser.add_argument("--skip-review", action="store_true", help="Skip Opus 4.6 post-review of results")
    parser.add_argument("--force", action="store_true", help="Ignore time guards (for manual test runs)")
    args = parser.parse_args()
    _force_mode = args.force

    os.makedirs(RESULTS_DIR, exist_ok=True)

    log("=" * 60)
    log(f"OVERNIGHT CODING SESSION — {datetime.date.today().isoformat()}")
    log(f"Tasks: {args.task} | Model: {MODEL_URL}")
    log(f"Hard stop: {HARD_STOP_HOUR:02d}:{HARD_STOP_MINUTE:02d}")
    log(f"Request timeout: {REQUEST_TIMEOUT}s")
    log(f"Force mode: {_force_mode}")
    log("=" * 60)

    # Model swap: if forced daytime run, swap to coder model first
    global _did_model_swap
    if _force_mode:
        _did_model_swap = swap_to_coder()

    # Wait for EVO and model to be ready (model swap at 22:00, we start at 22:30)
    log("Waiting for EVO coder model to be ready...")
    if not wait_for_model(max_wait=120):
        log("EVO coder model not ready after 120s — aborting")
        log("Check: systemctl status llama-server-coder on EVO")
        if _did_model_swap:
            swap_to_main()
        sys.exit(1)

    # Verify model responds
    try:
        resp = requests.post(MODEL_URL, json={
            "model": "qwen3-coder", "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 5,
        }, timeout=30)
        model_name = resp.json().get("model", "unknown")
        log(f"Model: {model_name} — OK")
    except Exception as e:
        log(f"Model unreachable after health check passed: {e}")
        sys.exit(1)

    # Read codebase
    src_files = read_all_src()
    total_lines = sum(v.count("\n") for v in src_files.values())
    log(f"Codebase: {len(src_files)} files, {total_lines} lines, {sum(len(v) for v in src_files.values())} bytes")

    start = time.time()
    results = []

    try:
        # Task 1: Router eval (runs until diminishing returns or time)
        if args.task in ("router-eval", "all"):
            r = task_router_eval(src_files)
            results.append(r)

        # Task 2: Unit tests (runs through all modules)
        if args.task in ("unit-tests", "all"):
            r = task_unit_tests(src_files)
            results.append(r)

        # Task 3: Code quality (deep analysis, fills remaining time)
        if args.task in ("code-quality", "all"):
            r = task_code_quality(src_files)
            results.append(r)

    except EVOUnreachableError as e:
        log(f"CIRCUIT BREAKER: {e} — saving results and exiting gracefully")
        results.append({"task": "aborted", "reason": str(e)})
    except Exception as e:
        log(f"FATAL: {e}")
        log(traceback.format_exc())
        results.append({"task": "error", "error": str(e)})

    elapsed = time.time() - start

    # Write comprehensive reports
    summary = {
        "date": datetime.datetime.now().isoformat(),
        "elapsed_seconds": round(elapsed),
        "elapsed_human": f"{round(elapsed/3600, 1)} hours",
        "results": results,
    }

    summary_path = os.path.join(RESULTS_DIR, f"summary-{datetime.date.today().isoformat()}.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)

    report_path = write_morning_report(results, elapsed)

    log(f"Session complete in {round(elapsed/60)} minutes ({round(elapsed/3600, 1)} hours)")
    log(f"Summary: {summary_path}")
    log(f"Briefing: {report_path}")
    log("=" * 60)

    # Opus post-review: send results to Claude Opus 4.6 for quality gate
    if not args.skip_review and any(r.get("branch") or r.get("rounds", 0) > 0 for r in results):
        try:
            opus_post_review(results, report_path)
        except Exception as e:
            log(f"Opus post-review failed (non-fatal): {e}")
    else:
        log("Skipping Opus review (no branches/changes to review)")

    run_cmd("git checkout main 2>/dev/null")

    # Swap back to VL model if we swapped for a forced daytime run
    if _did_model_swap:
        swap_to_main()


def _cleanup_swap():
    """Ensure model is swapped back if we die unexpectedly."""
    if _did_model_swap:
        try:
            swap_to_main()
        except Exception:
            pass


if __name__ == "__main__":
    import atexit
    atexit.register(_cleanup_swap)
    try:
        main()
    except KeyboardInterrupt:
        log("Interrupted by user")
    except SystemExit:
        raise
    except Exception as e:
        log(f"Unhandled error in main: {e}")
        log(traceback.format_exc())
