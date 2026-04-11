# Clint Group Participation + Console Instruction Stack

**Spec date:** 2026-04-11
**Author:** James C (with GPT-5.4)
**Status:** Design approved, pending review and implementation plan
**Related:** `docs/superpowers/specs/2026-04-01-clawd-console-design.md`, `docs/superpowers/specs/2026-03-28-memory-frontal-lobe-design.md`, `docs/superpowers/specs/2026-04-10-overnight-digest-and-console-design.md`

---

## 1. Why this exists

Clint already has most of the raw ingredients:

- routing and tool scoping
- memory retrieval
- group security modes
- an ambient agency path for `LQCore`
- an overnight evidence pipeline
- a console with health, memory, evolution, and overnight drill-down

What he does **not** yet have is a coherent participation layer. Today the system is better described as "a capable assistant with group features" than "a well-informed participant in live group discussion".

James's target state is broader than better prompts. He wants Clint to improve along four axes at once:

1. **Timing** — speak at the right moment, and stay silent when the marginal value is low.
2. **Substance** — add synthesis, challenge, recall, or research that meaningfully moves the discussion.
3. **Social feel** — sound like someone who is following the room rather than answering isolated prompts.
4. **Initiative** — occasionally contribute unprompted when confidence is high, not only when tagged.

The current console also exposes data, but not a clear behavioural control surface. As the system gets more agentic, James needs to see:

- what Clint is currently instructed to do
- why he spoke or stayed silent
- what memory and tools informed the turn
- how to tune group behaviour without reading code or scattered docs

This spec adds that missing participation layer and turns the console into the instruction surface for it.

---

## 2. Hard constraints

Two concerns are non-negotiable.

### 2.1 Do not replicate what already exists

This design must **extend**, not duplicate, the current system.

Specifically, it must not duplicate:

- `src/group-registry.js` security modes and blocked-topic restrictions
- `src/agency/policy.js` ambient-eligibility logic and intervention controls
- `src/cortex.js` selective intelligence gathering, memory injection, and speculative web prefetch
- the existing memory browser in `clawd-console/src/app/(console)/memory/page.tsx`
- the existing overnight drill-down and event-log work in `docs/superpowers/specs/2026-04-10-overnight-digest-and-console-design.md`
- the existing mission-control surface in `clawd-console/src/app/mission-control/page.tsx`

The new work should be a **thin orchestration layer** above these capabilities, with sharper modelling of participation decisions and better operator visibility.

### 2.2 Do not add material latency to the hot path

The current chat path is already latency-sensitive:

- `gatherIntelligence()` is selective and budgeted
- the tool loop is already the dominant expensive step
- ambient agency currently uses local heuristics plus a targeted classifier before a single group-mode generation

The new design must preserve those properties:

- no extra cloud model call before the main response
- no second broad retrieval pass on the same turn
- no duplicate memory search or web search just to explain decisions to the console
- heavy analysis must run asynchronously or be derived from already captured artifacts

The system may become **more selective** and **more observable**, but not substantially slower.

---

## 3. Outcome

Clint becomes a high-signal, low-noise participant in group chats who:

- speaks rarely but usefully when not directly addressed
- stays in the conversation when people engage with him, rather than acting as a one-shot responder
- feels more aware of topic state, group context, and prior decisions
- chooses a contribution role deliberately rather than defaulting to generic helpfulness
- pulls the minimum necessary memory/research/tools for that role
- makes it clear what message or thread he is responding to
- knows when to stop talking and hand the floor back
- exposes his current behavioural contract and recent decision logic in the Clint Console

End-state autonomy target outside `LQCore`: **rare-high-confidence ambient participation**.

Rollout constraint: the first implementation should preserve the current safe default posture for most groups and let James opt groups into the new posture via the console. Once intervention quality is proven, rare-high-confidence can become the default for eligible open groups.

---

## 4. Design overview

Add a new participation layer between raw group-message intake and final response generation.

```text
Incoming group message
  -> existing trigger / group security checks
  -> ParticipationPolicyService
  -> ConversationStateService
  -> ContributionPlannerService
  -> ContextPackService
  -> existing cortex + response generation
  -> ResponseOutcomeLog
  -> console surfaces + overnight learning inputs
```

This is not a replacement for the existing system. It is a decision layer that answers four questions explicitly:

1. Should Clint speak?
2. If yes, what kind of contribution is highest value?
3. What context is required for that exact contribution?
4. How should the result be delivered in this group?

---

## 5. What stays the same

To avoid duplication, these pieces remain authoritative:

### 5.1 Security and privacy

`src/group-registry.js` remains the source of truth for:

- `open` / `project` / `colleague`
- blocked-topic restrictions
- default privacy posture

This spec does not create a parallel group-permissions system.

### 5.2 Broad intelligence gathering

`src/cortex.js` remains the main path for:

- classification-aware memory gathering
- identity injection
- dream / insight / system context
- speculative web prefetch

The new participation layer chooses **when** and **why** to invoke context, but does not replace cortex with a second retrieval engine.

### 5.3 Existing console domains

The current console surfaces remain authoritative for:

- `Mission Control` as live operational status
- `Memory` as raw memory browse/edit
- `Overnight` as event-log and report drill-down

This spec reorganises and extends them with behavioural surfaces rather than building a second dashboard beside them.

---

## 6. Core participation principles

Four principles govern the whole design.

### 6.1 Not one-shot

If Clint contributes and somebody responds to him, he should treat that as an invitation into a bounded conversation rather than as a fresh cold-start turn.

This does **not** mean he becomes dominant. It means:

- he should answer follow-up questions naturally
- he should clarify or defend a point if challenged
- he should stay engaged long enough to be useful
- he should exit once the exchange is resolved or no longer benefits from his presence

### 6.2 Clear thread anchoring

Every contribution should make clear what Clint is responding to.

Preferred order:

1. native WhatsApp reply/quote when available
2. explicit mention of the speaker and point being answered
3. concise textual anchor to the claim, question, or decision being addressed

The user should never have to guess why Clint said something.

### 6.3 Research-aware pacing

If a better contribution requires brief research, Clint should be allowed to take a little time.

Behaviour rule:

- if the answer is already clear, answer immediately
- if current facts matter, do the research
- if research will be noticeably slow, send a brief acknowledgement first, then follow with the substantive answer

The acknowledgement must be short and functional, not theatrical. Example shape: "Checking that now." Then the real answer.

### 6.4 Anti-irritation first

The governing heuristic is:

**be extremely useful, but never socially costly without reason**

Concrete implications:

- do not repeat yourself
- do not answer the same objection three times in slightly different words
- do not keep pressing a point once the room has moved on
- do not turn every useful intervention into a mini-monologue
- do not stay in a thread once your marginal value drops below the annoyance threshold

---

## 7. New services

Five focused services are added. Each has one job.

### 7.1 `ParticipationPolicyService`

Purpose: own behavioural posture for each group.

Extends the current `agency/policy.js` idea from "can ambient agency run?" to "how should Clint participate here?"

Inputs:

- group JID
- group label
- group mode from `group-registry`
- default policy
- optional James overrides

Outputs:

- participation posture: `direct_only` | `rare_high_confidence` | `active_participant`
- cooldown window
- maximum unsolicited turns per hour
- verbosity ceiling
- allowed contribution types
- whether research injection is allowed
- whether memory recall is allowed

Persistence:

- new runtime file under `data/runtime/` for group participation profiles
- no duplication of privacy restrictions; those still come from `group-registry`

### 7.2 `ConversationStateService`

Purpose: maintain a lightweight rolling model of the live discussion.

This is not a full transcript summariser on every turn. It is a cheap state extractor over recent buffered messages plus cached state.

Tracked state:

- active topic labels
- unresolved questions
- decision-forming moments
- disagreement/tension markers
- whether Clint already spoke recently
- whether Clint is currently in an active follow-up exchange
- which messages Clint is replying to and which subsequent replies are addressed back to him
- whether the current message is a conversational opening or dead end

Sources:

- existing `buffer`
- topic-scan style transcript extraction
- prior group decision memory where relevant

Storage:

- compact per-group rolling state in `data/runtime/`
- refreshed cheaply on each message, with any heavier condensation deferred

### 7.3 `ContributionPlannerService`

Purpose: choose the single best intervention type for a given turn.

Allowed output roles:

- `silence`
- `answer`
- `memory_recall`
- `research_injection`
- `synthesis`
- `correction`
- `challenge`
- `decision_capture`
- `action_framing`

Decision rule:

- prefer one high-value move over broad usefulness
- optimise for benefit minus social cost
- if two roles are plausible, prefer the shorter and less intrusive one
- if Clint is in an active follow-up exchange, prefer direct continuation over starting a brand-new intervention

Implementation rule:

- use local heuristics and local classifiers first
- no extra cloud call for planning

### 7.4 `ContextPackService`

Purpose: assemble the minimum context required for the selected contribution role.

Examples:

- `memory_recall` -> prior decision + relevant memories + latest transcript slice
- `research_injection` -> transcript slice + factual claim + existing web prefetch or single targeted search
- `synthesis` -> transcript slice + active topic state + prior unresolved questions

Hard rule:

- one ranked context pack per turn
- no broad "throw everything into prompt" fallback for ambient participation

This service should preferentially reuse:

- already gathered transcript state
- existing cortex retrieval
- already available web prefetch results

### 7.5 `DeliveryStyleService`

Purpose: map contribution role + group profile to actual delivery style.

Controls:

- sentence count
- directness
- tolerance for wit
- whether Clint sounds advisory vs participatory
- whether he states decisions vs raises questions

This is not a new personality engine. It is a small renderer for group fit.

---

### 7.6 `ConversationEngagementService`

Purpose: manage bounded multi-turn participation after Clint has already entered a thread.

This service prevents the "one shot" failure mode without making Clint clingy.

Responsibilities:

- open a short-lived follow-up window after Clint speaks
- detect whether the next replies are substantively engaging with Clint
- relax intervention thresholds within that follow-up window
- close the window when the exchange is resolved, ignored, or socially complete

Suggested rules:

- if someone directly replies to Clint or clearly answers his point, Clint may continue conversationally
- follow-up mode expires quickly if nobody engages
- follow-up mode does not override privacy/security restrictions
- follow-up mode does not license long back-and-forths unless the group clearly wants one

---

## 8. Threading and stop rules

The biggest behavioural risk is not silence. It is overstaying.

### 8.1 Entering a conversation

Clint can enter a thread in three ways:

1. direct address
2. high-confidence unsolicited intervention
3. explicit reply to a previous Clint message

Only `2` should be heavily gated. Once a thread is legitimately open, `3` should be comparatively easy.

### 8.2 Follow-up window

After Clint speaks, open a short follow-up window for that thread.

Within that window:

- direct replies to Clint are treated as genuine conversational invitations
- follow-up answers should be faster and less threshold-heavy than unsolicited entry
- Clint should be allowed to ask or answer one clarifying question where it materially improves usefulness

Outside that window, the system reverts to normal participation thresholds.

### 8.3 Stop conditions

Clint should stop talking when any of the following is true:

- the question has been answered and nobody is pushing further
- another human has taken over productively
- the discussion has moved to a new topic
- Clint would only be repeating or slightly rephrasing himself
- his last contribution got no engagement and the room moved on
- the social cost of another message appears higher than the expected value

The important rule is:

**once useful value decays into conversational drag, stop**

### 8.4 Max consecutive presence

As an anti-irritation safeguard, Clint should have a soft limit on consecutive thread presence in ambient mode.

The exact number is an implementation choice, but the principle is fixed:

- in unsolicited mode, he should rarely occupy more than a short burst before yielding
- if humans keep pulling him back in directly, that is different and may justify a longer exchange

---

## 9. Hot-path latency budget

The design only works if it remains cheap.

### 9.1 Budget rule

The new participation layer should add:

- near-zero overhead for direct-triggered group turns
- low-millisecond overhead for direct-only groups
- sub-300ms typical overhead before generation for rare-high-confidence ambient evaluation, excluding any already-existing generation/tool latency

### 9.2 How to achieve that

Do:

- reuse existing buffered transcript data
- reuse existing `agency/policy.js` heuristics where possible
- use a compact local classifier for intervention-role selection if heuristics are insufficient
- piggyback on `cortex` for context gathering instead of creating a second retrieval path
- cache rolling conversation state by group
- treat follow-up turns as stateful continuations, not brand-new ambient evaluations

Do not:

- call an extra cloud model to decide whether to speak
- run broad memory search twice
- perform a second speculative web search after cortex has already done so
- write explanatory logs that require recomputing the decision

### 9.3 Research pacing and acknowledgements

If live research is needed and likely to take noticeable time:

- send a brief acknowledgement immediately
- do the research
- send the actual answer when ready

This preserves conversational naturalness without forcing Clint to bluff or rush.

These acknowledgement turns should be:

- opt-in only when latency is noticeable
- short enough not to irritate
- logged as part of the same conversation thread

### 9.4 Background-only work

The following belongs off the hot path:

- richer per-group behaviour summaries
- post-turn reaction analysis
- nightly intervention-quality scoring
- updating style/interaction memories
- generating operator-facing explanations beyond the structured decision fields already captured at runtime

---

## 10. Memory model for participation

This spec does not replace the memory service. It adds a clearer participation-oriented view over it.

Five memory lenses matter:

### 8.1 Stable group/person facts

- who people are
- roles
- durable preferences
- recurring constraints

### 8.2 Working thread memory

- what this group is discussing now
- what is unresolved
- what assumptions are driving the thread

### 8.3 Decision memory

- what was agreed
- what was rejected
- what was deferred
- who owns what

### 8.4 Interaction memory

- when Clint previously spoke
- what kind of intervention it was
- whether it landed well or badly

### 8.5 Voice/style memory

- how this group tends to speak
- what style Clint should avoid here
- how terse vs expansive successful turns have been

The existing memory browser remains the raw store browser. The console additions in this spec expose these five lenses as behavioural views, not separate storage systems.

---

## 11. Console redesign

The Clint Console should become a behavioural control plane, not just an observability panel.

### 11.1 Reuse principle

This spec reuses the existing console IA and pages wherever possible:

- `Mission Control` evolves into the posture/status overview
- `Memory` gains behavioural tabs rather than a second memory UI
- `Overnight` remains the source of overnight evidence and learning outcomes

### 11.2 New top-level surface: `Playbook`

Add a dedicated `Playbook` area for plain-English instructions.

It should answer:

- how Clint behaves in groups
- what the current default posture is
- how ambient participation works
- what memory is used for
- what each contribution role means
- how to tune thresholds and verbosity
- how follow-up conversations work
- how Clint decides to stop
- how to diagnose "too passive", "too chatty", "too robotic", "too obvious"

This is the human-readable instruction manual James asked for.

### 11.3 `Mission`

Extend `Mission Control` to show:

- current global posture summary
- default group autonomy target
- intervention budget and cooldown status
- model-use summary
- recent intervention acceptance/failure indicators

### 11.4 `Groups`

New or expanded per-group page:

- security mode from `group-registry`
- behavioural posture from `ParticipationPolicyService`
- allowed initiative types
- tone profile
- follow-up window settings
- stop-rule profile
- recent interventions with rationale
- feedback buttons:
  - good call
  - bad timing
  - too obvious
  - too long
  - wrong tone
  - overstayed
  - should have spoken

### 11.5 `Memory`

Keep the existing browser/editor, but add behavioural views:

- facts
- decisions
- active threads
- people
- interaction history
- style notes

These are filtered projections over existing memory and runtime artifacts, not a second memory system.

### 11.6 `Overnight`

Reuse the overnight event-log/report page and extend it with:

- interventions reviewed
- learned behavioural patterns
- candidate policy changes
- accepted / rejected behavioural adjustments

This keeps overnight learning in the existing evidence-first framework.

---

## 12. Instruction stack

The console needs a visible layered instruction model.

### 12.1 Layers

1. `Core identity`
2. `Global communication rules`
3. `Security/privacy restrictions`
4. `Participation policy`
5. `Role playbooks`
6. `Temporary experiments or overrides`

### 12.2 Effective instruction view

For any given group, the console should show:

- effective behaviour for this group right now
- where each rule came from
- what is inherited vs overridden

That prevents the current "complexity hidden in code and prompts" problem.

### 12.3 Role playbooks

Each contribution role should have a concise operator-facing description and machine-facing profile:

- when to use it
- when not to use it
- max length
- allowed sources
- desired tone

This makes Clint's behaviour tuneable in terms James can reason about.

---

### 12.4 Follow-up and stop playbooks

In addition to role playbooks, the console should expose two behavioural playbooks:

- `Follow-up behaviour`
- `Stop behaviour`

These define:

- when a reply counts as an invitation back into the conversation
- when Clint may ask for or perform brief research before replying
- when Clint should yield
- what "overstaying" means in practical terms

This is essential because irritation usually comes from persistence, not from the first message.

---

## 13. Logging and feedback

Every ambient or semi-ambient decision should produce a compact structured record:

- `shouldIntervene`
- `reason`
- `confidence`
- `interventionType`
- `policyName`
- `topicState`
- `contextSourcesUsed`
- `usedMemory`
- `usedWeb`
- `usedTools`
- `responseLength`
- `replyTarget`
- `followUpWindowOpen`
- `followUpTurnIndex`
- `reactionSignal` later, when available

These records feed:

- console drill-down
- operator feedback
- overnight learning

No extra recomputation should be required to render these in the console.

---

## 14. Rollout plan

### Phase 1: instrumentation and policy unification

- extend current ambient-agency logging
- add participation profiles
- add effective-instruction views in the console
- preserve current default ambient behaviour

### Phase 2: contribution planning

- add conversation state and contribution planner
- add follow-up window tracking and reply targeting
- route ambient decisions through the new planner
- keep direct-trigger path mostly unchanged

### Phase 3: console behavioural surfaces

- add group playbooks
- add behavioural memory views
- add intervention feedback controls
- add follow-up and stop-rule controls

### Phase 4: overnight learning loop

- analyse intervention outcomes overnight
- propose policy/style adjustments with evidence
- surface them in the existing overnight/event framework

This ordering avoids a big-bang rewrite and proves the decision layer before changing defaults.

---

## 15. Non-goals

This spec does not:

- replace `cortex`
- replace `group-registry`
- invent a second memory store
- make Clint a fully autonomous active participant in all groups immediately
- add extra cloud planning calls before every group response
- redesign the entire console from scratch
- require Clint to answer instantly when brief research would clearly improve the answer

The goal is not more machinery. The goal is better judgement using the machinery already present.

---

## 16. Success metrics

The new design is successful if, over replay tests and live operation:

- unsolicited interventions are fewer but more welcome
- follow-up exchanges feel natural rather than abrupt or clingy
- memory-backed interventions are more relevant
- factual interventions use research more appropriately
- James can explain Clint's current behavioural posture by reading the console
- latency on normal group turns remains materially unchanged
- ambient-group quality improves without a rise in chatty or repetitive behaviour

Suggested tracked metrics:

- intervention acceptance rate
- explicit negative reaction rate
- "should have spoken" misses
- "overstayed" feedback rate
- follow-up continuation success rate
- average unsolicited response length
- fraction of interventions with relevant memory or research support
- added pre-generation latency from the participation layer

---

## 17. Implementation note

The key architectural decision is this:

**Clint should not become a second system beside the current bot. He should become a better-governed version of the current bot, with one thin participation layer and one clear instruction surface.**

That is how this stays legible, fast, and evolvable.
