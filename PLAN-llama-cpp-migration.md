# Plan: Ollama → llama.cpp Migration + Overnight Model Upgrade

## Context
- **EVO X2**: AMD Ryzen AI Max+ 395, Radeon 8060S (RDNA 3.5, 40 CUs, gfx1151), 128GB unified LPDDR5X
- **VRAM allocation**: 96GB VRAM (GPU-resident), 31GB system RAM — confirmed via `rocm-smi`
- **ROCm**: 7.1.1 (HIP 7.1, Clang 20.0)
- **OS**: Ubuntu 24.04.4 LTS, kernel 6.17.0-1011-oem
- **Current**: Ollama hosting qwen3.5:35b (tool-calling) + qwen3:0.6b (classifier) + Whisper STT
- **Target**: llama-server (llama.cpp) with AMD-optimised build, permanently loaded models, overnight reasoning model

## Why
- Ollama adds 10-30% overhead vs raw llama.cpp
- Ollama unloads models (keep_alive=-1 is runtime-only, resets on restart)
- llama-server keeps models loaded for process lifetime — zero cold starts
- AMD-specific build flags (HIP, rocWMMA flash attention) unlock significant perf
- 96GB VRAM can hold multiple models simultaneously (interactive + classifier = 25.6GB, leaving 70GB)

## VRAM Strategy (UPDATED)
- **Do NOT use UMA mode** (`GGML_HIP_UMA=OFF`) — we have 96GB dedicated VRAM
- Models load directly into VRAM for fastest GPU access
- UMA would route through 31GB system RAM via CPU memory controller — slower
- Budget: 96GB VRAM = interactive (25GB) + classifier (0.6GB) + KV cache + overhead
- Overnight: swap interactive model for reasoning model (42.5GB) or run both if within budget

## Phase 1: Build llama.cpp on EVO X2 ✅ COMPLETED

### 1.1 ROCm ✅
- ROCm 7.1.1 installed and verified
- GPU detected: AMD Radeon Graphics, gfx1151, 96GB VRAM

### 1.2 Build ✅
```bash
cd ~/llama.cpp
git reset --hard origin/master  # commit 509a31d00, build 8419
cmake -B build \
  -DGGML_HIP=ON \
  -DGGML_HIP_ROCWMMA_FATTN=ON \
  -DAMDGPU_TARGETS=gfx1151 \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j$(nproc)
```
Binaries: `~/llama.cpp/build/bin/{llama-server,llama-bench,llama-cli}`

### 1.3 Models
| Slot | Model | Quant | Size | File | Source |
|------|-------|-------|------|------|--------|
| Interactive | Qwen3.5-35B-A3B (MoE, 3B active) | Q5_K_M | 25GB | `Qwen_Qwen3.5-35B-A3B-Q5_K_M.gguf` | bartowski |
| Classifier | Qwen3-0.6B | Q8_0 | 639MB | `Qwen3-0.6B-Q8_0.gguf` | unsloth |
| Overnight | DeepSeek-R1-Distill-Llama-70B | Q4_K_M | 42.5GB | `DeepSeek-R1-Distill-Llama-70B-Q4_K_M.gguf` | bartowski |

All models stored in `~/models/`.

Note: Qwen3.5:35b is MoE (35B total, 3B active per token) — extremely fast inference but not comparable to a dense 35B. The DeepSeek-R1-Distill is dense 70B — slower but much stronger reasoning.

### 1.4 Benchmark
```bash
# Environment for optimal AMD performance
export HSA_OVERRIDE_GFX_VERSION=11.5.1
export ROCBLAS_USE_HIPBLASLT=1

# Benchmark each model
~/llama.cpp/build/bin/llama-bench -m ~/models/Qwen_Qwen3.5-35B-A3B-Q5_K_M.gguf -ngl 999
~/llama.cpp/build/bin/llama-bench -m ~/models/Qwen3-0.6B-Q8_0.gguf -ngl 999
~/llama.cpp/build/bin/llama-bench -m ~/models/DeepSeek-R1-Distill-Llama-70B-Q4_K_M.gguf -ngl 999
```

### 1.5 Disk cleanup (completed)
Freed ~180GB: trash (43GB), vllm (48GB), old ROCm 6.2 venvs (36GB), stale GGUF cache (52GB).

## Phase 2: Create systemd services

### 2.1 Main tool-calling server (replaces Ollama for qwen3.5:35b)
```ini
[Unit]
Description=llama.cpp tool-calling server (Qwen3.5-35B-A3B)
After=network.target

[Service]
Type=simple
User=james
Environment=HSA_OVERRIDE_GFX_VERSION=11.5.1
Environment=ROCBLAS_USE_HIPBLASLT=1
ExecStart=/home/james/llama.cpp/build/bin/llama-server \
  -m /home/james/models/Qwen_Qwen3.5-35B-A3B-Q5_K_M.gguf \
  --host 0.0.0.0 --port 8080 \
  -ngl 999 -c 8192 --parallel 2
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### 2.2 Classifier server (qwen3:0.6b on port 8081)
```ini
[Unit]
Description=llama.cpp classifier server (Qwen3-0.6B)
After=network.target

[Service]
Type=simple
User=james
Environment=HSA_OVERRIDE_GFX_VERSION=11.5.1
ExecStart=/home/james/llama.cpp/build/bin/llama-server \
  -m /home/james/models/Qwen3-0.6B-Q8_0.gguf \
  --host 0.0.0.0 --port 8081 \
  -ngl 999 -c 2048 --parallel 1
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### 2.3 Kernel parameter
- Add `amdgpu.runpm=0` to GRUB_CMDLINE_LINUX to prevent GPU power management latency spikes
- Requires reboot after change

## Phase 3: Update bot code

### 3.1 New config vars
```
EVO_LLAMA_URL=http://192.168.1.230:8080    # llama-server main (tool-calling)
EVO_CLASSIFIER_URL=http://192.168.1.230:8081  # classifier
EVO_USE_LLAMA_CPP=true                      # feature flag (false = rollback to Ollama)
```

### 3.2 Update ollama.js → evo-llm.js
- Change API format: Ollama `/api/chat` → OpenAI-compatible `/v1/chat/completions`
- Remove keep_alive management (not needed — model always loaded)
- Remove keepEvoModelWarm() from scheduler (not needed)
- Update tool format conversion (OpenAI format instead of Ollama format)
- Add feature flag check: if `EVO_USE_LLAMA_CPP=false`, fall back to Ollama

### 3.3 Update router.js classifier calls
- Point classifier to port 8081 with OpenAI format
- Classifier prompt stays the same, just API format changes

## Phase 4: Overnight model + thinking mode

### 4.1 Overnight model management
- DeepSeek-R1-Distill-Llama-70B Q4_K_M (42.5GB) for overnight reasoning
- Option A: Separate llama-server instance on port 8082 (started/stopped by overnight cycle)
- Option B: Use llama-swap for on-demand model switching
- Option C: Stop interactive server, start overnight server, swap back at end

### 4.2 Update self-improve/cycle.js
- Use overnight model for probe generation + rule proposal
- Enable extended reasoning (DeepSeek-R1 natively produces `<think>` tokens)
- Add reflection step: feed failed proposals back as learning signal
- Increase num_predict for reasoning chains

### 4.3 Multi-agent architecture (future)
```
┌─────────────────────────────────────────────┐
│              ORCHESTRATOR (70B)              │
│  Plans iteration strategy, reviews results  │
└──────────┬──────────────┬───────────────────┘
           │              │
    ┌──────▼──────┐  ┌────▼────────────┐
    │  PROBER     │  │  ANALYST        │
    │  (35B fast) │  │  (70B thinking) │
    │  Generates  │  │  Reviews router │
    │  synthetic  │  │  telemetry,     │
    │  messages   │  │  finds patterns │
    └──────┬──────┘  └────┬────────────┘
           │              │
    ┌──────▼──────────────▼──────────┐
    │         PROPOSER (70B)         │
    │  Writes regex rules from       │
    │  combined prober + analyst     │
    └──────────────┬─────────────────┘
                   │
    ┌──────────────▼─────────────────┐
    │        VALIDATOR (35B fast)    │
    │  Runs eval suite, cross-       │
    │  contamination, regression     │
    └──────────────┬─────────────────┘
                   │
    ┌──────────────▼─────────────────┐
    │        REFLECTOR (70B)         │
    │  Reviews failed proposals,     │
    │  suggests refinements,         │
    │  identifies eval gaps          │
    └────────────────────────────────┘
```

## Phase 5: Phase out Claude

### 5.1 Expand local routing
- As self-improvement adds keywords → more messages classified → more go local
- Track % local vs Claude in routing stats
- Target: Claude only for explicit requests, email confirmations, images

### 5.2 Add explicit Claude trigger
- "/claude" or "ask claude" prefix forces Claude
- Everything else routes locally by default
- Fallback to Claude on local model failure/timeout

## SSH Access Pattern
```bash
# Direct to EVO (via Pi hop):
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ssh james@192.168.1.230 '<command>'"
# Or: SCP via Pi staging
scp -i C:/Users/James/.ssh/id_ed25519 <file> pi@192.168.1.211:/tmp/
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "scp /tmp/<file> james@192.168.1.230:~/<dest>"
```

## Risk Mitigation
- Keep Ollama running alongside llama-server during migration
- Feature flag: `EVO_USE_LLAMA_CPP=true/false` to switch between backends
- Rollback: just flip the flag back to Ollama
- Run eval suite after each phase to verify no regression
- Ollama models remain cached — can restart Ollama service instantly if needed

## Expected Outcomes
- 30-50% faster inference for interactive queries
- Zero cold starts (model always loaded in VRAM)
- 70B overnight reasoning model for higher-quality self-improvement
- Native thinking/reasoning tokens from DeepSeek-R1
- Path to full Claude phase-out for non-mutation queries
