# Voice Pipeline State Machine Design

## Problem
The voice listener (`evo-voice/voice_listener.py`) has implicit states in a while loop with nested ifs. This causes:
- Silent failures (commands processed but no audio output)
- Mic bleed-through (TTS picked up by mic, transcribed as commands)
- No timeout guarantees (hung API calls produce silence forever)
- Inconsistent follow-up mode (only after Claude, not local commands)

## Solution
Explicit state machine with guaranteed audio output, timeouts, and structured logging.

## States

| State | Timeout | On Timeout | Mic State |
|-------|---------|------------|-----------|
| IDLE | none | — | open |
| RECORDING | 12s | transcribe what we have | open |
| TRANSCRIBING | 5s | speak "Sorry, I didn't catch that" → IDLE | suppressed |
| ACK_LISTEN | 8s | IDLE silently (no command given) | suppressed→open |
| ROUTING | 3s | fall through to Claude | suppressed |
| WAITING | 30s | speak "Sorry, that's taking too long" → IDLE | suppressed |
| SPEAKING | audio_dur + 1s | force-stop → IDLE | suppressed |
| FOLLOW_UP | 10s | IDLE silently | open |

## Invariants
1. No state can exit without producing audio OR returning to IDLE with a log entry
2. Every API call has an explicit timeout
3. Mic is suppressed during all non-listening states
4. Every state transition is logged with: from_state, to_state, duration_ms, context

## Speed Optimisations
- Silence detection: 1.2s → 0.8s (faster end-of-speech detection)
- Pre-buffer: keep rolling 0.3s buffer so speech start isn't clipped
- Fuzzy wake matching: Levenshtein distance ≤ 3 catches "take lord", "accord" etc
- Piper pre-warmed at startup (already done)

## Implementation
- Python enum for states
- Single `run()` loop with match/case on current state
- Each state handler returns (next_state, context_dict)
- Wrapper catches all exceptions, speaks error, returns to IDLE

## Files Changed
- `evo-voice/voice_listener.py` — full rewrite of main loop
- `src/index.js` — ensure all /api/voice-local handlers return speakable `message` text
- `architecture.md` — update to reflect current system (llama.cpp, not Ollama)
