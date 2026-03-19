# Voice Pipeline Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the voice pipeline so commands are reliably captured, naturally acknowledged, and correctly routed end-to-end.

**Architecture:** The EVO X2 runs the voice listener (mic → Whisper → wake phrase → API). The Pi handles command execution (Claude/tools) and dashboard updates (SSE). The fix addresses three layers: audio capture (pre-buffer), user experience (natural responses), and command routing (wake phrase reliability).

**Tech Stack:** Python (voice_listener.py on EVO), Rust/egui (dashboard on Pi), Node.js (clawdbot API on Pi)

---

## Diagnosis

### Problem 1: Wake word is lost in pre-trigger audio
When James says "Claude, show me my emails", the word "Claude" triggers speech detection (RMS spike). But recording only starts AFTER 3 consecutive chunks confirm speech (240ms delay). By then "Claude" has been spoken and only "show me my emails" is captured. Wake phrase check fails → command silently discarded.

**Evidence:** Log shows `Whisper: 'my e-mails.'` and `No wake phrase in: 'my e-mails.'`

### Problem 2: No natural feedback
The dashboard shows raw state names. No "How can I help?" when wake word detected. No "Working on it..." while Claude processes. No confirmation of what was heard.

### Problem 3: Fan noise interference
The EVO X2 fan creates ambient noise around RMS 1600-1900 (at gain 6.0). The speech threshold (now 3000) filters most of it, but the fan makes transcription noisier and reduces accuracy for quiet speech.

### Problem 4: Misrouted gratitude
"Thank you, Claude" was routed as `refresh` and `navigate` by the local route-command service. Gratitude should be handled gracefully, not treated as an actionable command.

## What Voice Commands Can Actually Do

### Tier 1: Local fast actions (via `/api/voice-local`, no Claude call)
| Command pattern | Action | Example |
|----------------|--------|---------|
| "navigate to [panel]" | `navigate` | "Claude, show me emails" → navigate to email panel |
| "add todo [text]" | `todo_add` | "Claude, add a todo buy milk" |
| "complete [todo text]" | `todo_complete` | "Claude, complete the timesheets todo" |
| "what's on my calendar" | `calendar_list` | Shows cached calendar events |
| "remember [note]" | `remember` | Stores in EVO memory service |
| "refresh" | `refresh` | Forces widget data refresh |

### Tier 2: Full Claude (via `/api/voice-command`, full tool access)
| Command pattern | Tools used | Example |
|----------------|-----------|---------|
| Email queries | `gmail_search`, `gmail_read` | "Claude, show me my emails" |
| Calendar creation | `calendar_create_event` | "Claude, book a meeting tomorrow at 3" |
| Travel queries | `train_departures`, `hotel_search` | "Claude, trains from York to London" |
| Web search | `web_search` | "Claude, search for weather in Leeds" |
| Complex questions | All tools | "Claude, what's happening this weekend" |

### Route-command on EVO (localhost:5100)
This IS implemented — the logs show it returning routing decisions (`Route: refresh (tier 2)`, `Route: navigate (tier 2)`). It classifies the command text and returns `{ action, params, tier }`. The voice listener then calls either `/api/voice-local` (fast) or `/api/voice-command` (Claude).

---

## Tasks

### Task 1: Add rolling pre-buffer to capture wake word

**Files:**
- Modify: `evo-voice/voice_listener.py` (main loop, lines 444-498)

**Problem:** The 3-chunk speech confirmation (240ms) means the start of the wake word is lost. Need to keep a rolling buffer of recent audio and prepend it to the recording.

**Step 1: Add pre-buffer collection in main loop**

In the main loop (line 445), before the speech detection logic, maintain a rolling deque of the last 10 chunks (~800ms at 80ms/chunk). When speech is confirmed, prepend the pre-buffer to the recording.

```python
# At top of file, add import
from collections import deque

# In main(), before the while loop (after line 443):
PRE_BUFFER_CHUNKS = 10  # ~800ms of audio before speech trigger
pre_buffer = deque(maxlen=PRE_BUFFER_CHUNKS)

# In the while loop, BEFORE the speech threshold check:
pre_buffer.append(audio_16k)

# When speech is confirmed (after line 466, "Speech detected"):
# Change: frames_16k = [audio_16k]
# To:     frames_16k = list(pre_buffer)
```

This captures the ~800ms before speech detection triggered, ensuring the wake word is in the recording even if it's what caused the RMS spike.

**Step 2: Verify and deploy**

Deploy to EVO via Pi hop. Check logs for transcriptions that now include the wake word.

**Step 3: Commit**

```bash
git add evo-voice/voice_listener.py
git commit -m "fix(voice): add pre-buffer to capture wake word before speech trigger"
```

---

### Task 2: Handle gratitude / no-op commands gracefully

**Files:**
- Modify: `evo-voice/voice_listener.py` (after wake phrase detection, lines 516-537)

**Problem:** "Thank you, Claude" gets routed as `refresh` or `navigate`. Should be treated as conversational.

**Step 1: Add gratitude detection after wake phrase strip**

After stripping the wake phrase (line 518), check if the remaining command is just gratitude/filler:

```python
GRATITUDE_PHRASES = {
    "thank you", "thanks", "cheers", "ta", "nice one",
    "good job", "well done", "great", "perfect", "brilliant",
}

# After line 518 (command = strip_wake_phrase(text)):
command_lower = command.lower().rstrip(".,!?")
if command_lower in GRATITUDE_PHRASES or not command.strip():
    speak("You're welcome" if command_lower in GRATITUDE_PHRASES else "Yes?")
    logger.info(f"Gratitude/empty: {command!r}")
    notify_dashboard("listening")
    speech_count = 0
    continue
```

**Step 2: Deploy and test**

**Step 3: Commit**

---

### Task 3: Natural voice feedback — dashboard overlay text

**Files:**
- Modify: `evo-voice/voice_listener.py` (notify_dashboard calls)
- Modify: `clawd-dashboard/src/api.rs` (SSE voice event processing)
- Modify: `clawd-dashboard/src/main.rs` (overlay rendering text)

**Problem:** Dashboard shows generic state labels. Should show natural text.

**Step 1: Improve notify_dashboard payloads from voice listener**

Update the voice listener to send richer status messages:

```python
# Line 467 (speech detected, before recording):
notify_dashboard("processing")  # already exists, but change to:
notify_dashboard("listening", {"message": "Listening..."})

# Line 520 (wake phrase matched, has command):
notify_dashboard("activated", {"text": command, "message": "How can I help?"})
# This already exists at line 520

# Line 342 (command worker, sending to clawdbot):
notify_dashboard("command", {"text": command, "message": "Working on it..."})
```

**Step 2: Update dashboard overlay to use the message field**

In `main.rs`, the voice overlay currently shows hardcoded text like "Listening..." and "Thinking...". Update it to use `voice_message` from SSE state when available, falling back to defaults.

The SSE handler in `api.rs` already stores `voice_message` (line 258). The overlay in `main.rs` should prefer `voice_message` over hardcoded text.

**Step 3: Deploy dashboard and voice listener**

**Step 4: Commit**

---

### Task 4: Improve wake-only response

**Files:**
- Modify: `evo-voice/voice_listener.py` (lines 522-527, wake phrase only handler)

**Problem:** When user says just "Claude" (wake word only, no command), the system says "Yes?" but doesn't listen for a follow-up command. It should enter a brief listening window for the actual command.

**Step 1: Add follow-up listening after wake-only detection**

After detecting wake word with no command, record for a few more seconds:

```python
# Replace lines 522-527 (wake phrase only block):
if not command:
    speak("How can I help?")
    notify_dashboard("activated", {"message": "How can I help?"})
    logger.info("Wake phrase only — listening for follow-up")

    # Brief recording window for the actual command
    followup_frames = []
    followup_start = time.time()
    followup_silence = None
    while time.time() - followup_start < 5.0:  # 5s window
        data = stream.read(device_chunk, exception_on_overflow=False)
        audio_native = np.frombuffer(data, dtype=np.int16)
        audio_16k = resampler.resample(audio_native, gain=MIC_GAIN)
        level = rms_np(audio_16k)
        if level > SPEECH_THRESHOLD:
            followup_frames.append(audio_16k)
            followup_silence = None
        elif followup_frames:
            if followup_silence is None:
                followup_silence = time.time()
            elif time.time() - followup_silence > SILENCE_DURATION:
                break

    if followup_frames:
        text = transcribe_local(followup_frames)
        if text and not is_hallucination(text):
            command = text
            logger.info(f"Follow-up command: {command!r}")
            route = route_command(command)
            _command_queue.put((command, route))
        else:
            notify_dashboard("listening")
    else:
        notify_dashboard("listening")

    speech_count = 0
    continue
```

**Step 2: Deploy and test with two-part speech: "Claude" [pause] "show me my emails"**

**Step 3: Commit**

---

### Task 5: Fan noise mitigation — consider mic placement

**No code change needed for this task — hardware decision.**

The EVO X2 fan runs constantly and creates ambient noise at RMS 1600-1900 (at 6x gain). Options:

1. **Move the USB mic further from the EVO** — e.g., on a short USB extension cable, placed closer to where James speaks. This is the simplest and most effective fix.

2. **Move mic to Pi** — the Pi 5 fan is quieter (or can be disabled with a heatsink case). But this means Whisper must run on the Pi (slow, 4GB RAM) or audio must be streamed to EVO over network. Not recommended.

3. **Software noise gate** — add spectral subtraction or a noise profile. Complex, fragile, and the current threshold approach already works if the mic is positioned better.

**Recommendation:** Keep mic on EVO but use a USB extension cable to place it 1-2 metres away from the fan. The speech threshold (3000) already handles moderate ambient noise well.

---

## Deployment Checklist

For each code task, deploy using the exact commands from CLAUDE.md:

```bash
# Voice listener to EVO (via Pi hop)
scp -i C:/Users/James/.ssh/id_ed25519 evo-voice/voice_listener.py pi@192.168.1.211:/tmp/voice_listener.py
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "scp /tmp/voice_listener.py james@192.168.1.230:~/clawdbot-memory/voice_listener.py"
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ssh james@192.168.1.230 'sudo systemctl restart clawdbot-voice'"

# Dashboard to Pi
scp -i C:/Users/James/.ssh/id_ed25519 clawd-dashboard/src/main.rs pi@192.168.1.211:~/clawd-dashboard/src/main.rs
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "source ~/.cargo/env; cd ~/clawd-dashboard && cargo build --release"
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "pkill clawd-dashboard 2>/dev/null; sleep 2; export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0; nohup ~/clawd-dashboard/target/release/clawd-dashboard > /tmp/clawd-dashboard.log 2>&1 &"

# Verify
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ssh james@192.168.1.230 'journalctl -u clawdbot-voice -n 20 --no-pager'"
```

## Verification

After all tasks deployed, test these specific commands:

1. **"Claude, show me my emails"** — should transcribe with wake word, route to Claude, get email response on dashboard
2. **"Claude"** [pause] **"what's on my calendar"** — wake-only detection, follow-up listen, command execution
3. **"Thank you, Claude"** — should get "You're welcome" TTS, NOT trigger refresh/navigate
4. **"Claude, add a todo call the dentist"** — fast local todo_add, toast confirmation on dashboard
5. **Silence** — no false triggering (verify no "Speech detected" spam in logs)
