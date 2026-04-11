# SOVREN Spreadsheet Ingest and Methodology Contribution Store

**Spec date:** 2026-04-11
**Author:** James C (with Claude Opus 4.6)
**Status:** Design approved, pending implementation plan
**Related:**
- `docs/superpowers/specs/2026-04-11-group-participation-and-console-design.md` (group follow-up workflow)
- `C:\Users\James\Desktop\Projects\SOVREN\backend\app\services\extraction\extraction_service.py` (SOVREN's existing PDF extraction pipeline)
- `src/document-handler.js` (clawdbot's current PDF/DOCX/text handler)

---

## 1. Why this exists

### 1.1 The immediate trigger
On 2026-04-11, Peter (alpha tester for SOVREN) sent a multi-part contribution to the SOVREN WhatsApp group:
1. A cover email describing a notional valuation of awards against Venezuela, Spain and Egypt at three stages (Claim, Award, post-annulment).
2. The Excel spreadsheet itself (`Arbitration Award Sovren Template.xlsx`) containing the worked examples.
3. A draft Sovren© valuation report template using formal client-facing language.

Clint silently dropped:
- The spreadsheet attachment (no `.xlsx` support in `document-handler.js`).
- The "And finally:" continuation message.
- The template message.

The follow-up workflow fix (separate spec) addresses the second and third drops. This spec addresses the first drop and the larger storage problem behind it.

### 1.2 The structural problem
Peter's spreadsheet is not the same kind of document as the arbitration award PDFs SOVREN already extracts from. SOVREN's existing extractors (`commercial_court_extractor.py`, `icc_extractor.py`, `icsid_extractor.py`) target **adversarial legal facts** in **formatted award documents** — claimant, respondent, principal_amount, interest_rate, costs allocation. Peter's spreadsheet targets a different layer entirely: it is a **methodology specification expressed as live formulas**.

The semantic content of the spreadsheet is:
- Row 26 = the algorithm in raw form (one formula).
- Row 28 = Row 26 discounted at the Purchaser's IRR (15%) for years to recovery (Component 1).
- Row 30 = Row 26 × S-factor (Component 2).
- Row 35 = mean(Row 28, Row 30) (the valuation).

A flat text dump of cell values throws away every meaningful element: the formula structure, the dependency graph between cells, the named ranges, and the row anchors that Peter is using as semantic labels.

### 1.3 The storage problem
There is no current mechanism to record:
- Who contributed what methodology change to SOVREN
- When they contributed it
- Which part of the SOVREN engine the contribution affects
- Whether the contribution has been incorporated, rejected, or is still pending review
- What the v1 → v2 lineage of a contributor's evolving model looks like

Without that, every contribution becomes a chat log fragment that gets forgotten the next time the SOVREN engine code is touched. This spec creates the storage layer that closes that gap.

---

## 2. Hard constraints

### 2.1 Determinism is sacred
SOVREN's defining property is that its valuation chain is non-generative and human-validated. The methodology contribution store must inherit that property. The deterministic structural parse of every spreadsheet is the source of truth. The LLM-derived methodology JSON is a derived view, always rebuildable from the structural parse, never the canonical record.

### 2.2 No separate database
clawdbot already runs without a database (JSON file persistence). SOVREN's methodology contribution store will be the same: directories of files in the SOVREN project mirror, picked up by `project_sync`, queryable through clawdbot's existing `project_read` / `project_file_read` tools.

### 2.3 No new ingest channel
Contributions arrive via WhatsApp through Clint, the same channel Peter is already using. No new web upload form, no new API endpoint that the contributor has to learn. The existing WhatsApp document path is the only contributor-facing surface.

### 2.4 Cross-reference must be live, not aspirational
The morning report (already implemented as part of the overnight pipeline) must surface affected contributions when SOVREN code changes. A "store" that nobody reads three months later is a failure. The contribution index is consulted by the existing morning briefing path, not a separate dashboard.

### 2.5 No xlsx parsing in SOVREN's `extraction_service.py`
SOVREN's extraction pipeline stays focused on adversarial legal documents (PDFs, DOCX, scanned awards). xlsx ingest lives in clawdbot, not SOVREN backend. The two pipelines do not merge.

---

## 3. Outcome

A contributor (Peter, future contributors, James himself) drops an `.xlsx` file into a SOVREN-affiliated WhatsApp chat. Within seconds:

1. Clint downloads the file.
2. The structural parser produces a deterministic JSON of every sheet, cell, formula, named range.
3. The methodology pass produces a structured `MethodologyContribution` JSON via EVO 30B (local, free).
4. Both are written to the SOVREN project mirror under a contributor-and-date-keyed directory.
5. The `index.json` is updated.
6. Clint replies in the chat with a substantive acknowledgement that quotes specific cells and formulas, flags any conflict with the existing SOVREN spec, and asks targeted questions.

Three months later, James asks Clint "what did Peter say about the S-factor weighting?". Clint reads the contribution index, finds Peter's two relevant contributions, and answers with citations to specific cells and formulas — not a chat-log paraphrase.

When the SOVREN backend `valuations.py` is changed and the change touches a function listed in any contribution's `links.json`, the next morning report flags those contributions as "needs re-check against new code".

---

## 4. Architecture overview

Two new modules in clawdbot, one new directory tree in the SOVREN project mirror, one new overnight task.

```
WhatsApp message with .xlsx
  -> message-handler.js (existing path, gated by follow-up window fix)
  -> document-handler.js (existing path, extended)
  -> XlsxParser (new, structural pass)
  -> MethodologyExtractor (new, EVO 30B pass)
  -> ContributionStore (new, writes to /home/james/projects/sovren/notes/methodology-contributions/)
  -> contribution-index.json updated
  -> existing project_sync picks up new files on next run
  -> Clint acknowledgement reply (substantive, cites specific cells)

Overnight (existing pipeline + one new step)
  -> git diff of SOVREN repo
  -> contribution-index.json scanned for affected contributions
  -> morning report enriched with "contributions affected by recent code changes"
```

---

## 5. What stays the same

To avoid duplication, these pieces remain authoritative:

### 5.1 Document download path
`message-handler.js` downloads documents at line 402 via Baileys' `downloadMediaMessage`. No change to the download path. The new xlsx handling slots in alongside the existing PDF and DOCX branches.

### 5.2 Memory storage
`memory.js` `storeDocument()` continues to receive a raw text + summary for long-term retrieval and dream mode. The new contribution store is **additional** storage with stronger structure, not a replacement for the document memory.

### 5.3 SOVREN's PDF extraction
`extraction_service.py` and the tribunal-specific extractors (`icsid_extractor`, `icc_extractor`, `commercial_court_extractor`) are untouched. They continue to handle award PDFs through the existing dual-track regex+LLM path.

### 5.4 project_sync
The existing `project-sync` task already mirrors `/home/james/projects/sovren/` into clawdbot's project knowledge. New files under `notes/methodology-contributions/` flow through this same path with no special-casing.

### 5.5 Morning report
`briefing.js` already reads structured event-log events into the morning WhatsApp DM. The new "contributions affected by code changes" section is a new event type, not a new code path.

---

## 6. New components

### 6.1 `XlsxParser` (clawdbot, new)

**Location:** `src/sovren/xlsx-parser.ts`

**Purpose:** Deterministic structural parse of an `.xlsx` file. No LLM, no inference, no interpretation. Output is reproducible byte-for-byte from the input.

**Library:** `exceljs` (battle-tested, pure JS, preserves formulas and named ranges, no native dependencies). Not `xlsx` (SheetJS) — it loses formulas in the community edition.

**Output shape (`XlsxStructure`):**
```typescript
interface XlsxStructure {
  fileName: string;
  fileHash: string; // sha256 of the original file
  sheetCount: number;
  sheets: SheetStructure[];
  definedNames: DefinedName[];
  parsedAt: string; // ISO timestamp
}

interface SheetStructure {
  name: string;
  rowCount: number;
  columnCount: number;
  cells: CellRecord[]; // only non-empty cells
  mergedRanges: string[]; // e.g. ["A1:C1"]
}

interface CellRecord {
  address: string; // "A1", "B26", etc.
  row: number;
  column: number;
  value: string | number | boolean | null; // computed value
  formula: string | null; // raw formula text if any (e.g. "=B26*0.85")
  type: 'string' | 'number' | 'boolean' | 'date' | 'formula' | 'empty';
  numberFormat: string | null;
}

interface DefinedName {
  name: string;
  refersTo: string; // e.g. "Sheet1!$B$5"
}
```

**Hard rules:**
- No truncation. Every non-empty cell appears in the output.
- Cell `value` is the computed result; `formula` is the source. Both kept.
- File hash is computed before parsing and stored, so the contribution can be re-verified later.

### 6.2 `MethodologyExtractor` (clawdbot, new)

**Location:** `src/sovren/methodology-extractor.ts`

**Purpose:** Convert an `XlsxStructure` plus accompanying cover text into a structured `MethodologyContribution` JSON. Uses EVO 30B (local, free, already running). Single LLM call per contribution.

**Input:**
- `XlsxStructure` (deterministic ground truth)
- `coverText: string` (the cover email or chat message that preceded the file)
- `contributorName: string`
- `existingMethodology: string | null` (the current SOVREN spec on file, for diff/conflict detection)

**Output shape (`MethodologyContribution`):**
```typescript
interface MethodologyContribution {
  contributor: string;
  receivedAt: string;
  sourceFileHash: string;
  variables: VariableSpec[];
  formulas: FormulaSpec[];
  anchorCells: AnchorCell[];
  worked_examples: WorkedExample[];
  open_questions: string[]; // questions Clint has after reading the contribution
  conflicts: ConflictNote[]; // points where this contribution disagrees with the existing spec
  suggestedLinks: string[]; // SOVREN code paths this contribution likely affects (LLM guess, James approves)
  status: 'pending';
}

interface VariableSpec {
  name: string; // e.g. "S_Factor", "IRR", "GCV_accrued"
  definition: string; // contributor's stated definition
  source_cells: string[]; // ["Sheet1!B4", "Sheet1!B5"]
  domain: string; // "[0, 1]", "percent", "currency", etc.
}

interface FormulaSpec {
  label: string; // contributor's name for the formula
  symbolic: string; // e.g. "Component_1 = Row_26 * (1 / (1 + IRR)^T)"
  source_cell: string; // "Sheet1!B28"
  depends_on: string[]; // ["Sheet1!B26", "Sheet1!B5"]
  appears_in_examples: string[]; // ["Venezuela", "Spain", "Egypt"]
}

interface AnchorCell {
  reference: string; // "Row 26", "Row 35"
  meaning: string; // "raw algorithm output", "final valuation"
  cells: string[]; // actual cell addresses these correspond to
}

interface WorkedExample {
  name: string; // "Venezuela", "Spain", "Egypt"
  stage: string; // "Claim" | "Award_pre_annulment" | "Award_post_annulment"
  inputs: Record<string, string>;
  output: string;
}

interface ConflictNote {
  with: string; // "current SOVREN formula on file"
  description: string;
  severity: 'low' | 'medium' | 'high';
}
```

**Prompt strategy:**
- System prompt anchors the model on SOVREN's determinism principle and the existing formula on file.
- User prompt provides the structural JSON plus cover text plus existing methodology.
- Output must be valid JSON conforming to the schema. Validation runs after the call; on failure, the methodology JSON is omitted (the structural parse still gets stored), and the failure is logged with the raw output for debugging.

**Hard rule:** the methodology JSON is always derived from the structural JSON. If methodology extraction fails, the contribution is still stored — just with `methodology.json` absent and an `extraction-failed.txt` marker.

### 6.3 `ContributionStore` (clawdbot, new)

**Location:** `src/sovren/contribution-store.ts`

**Purpose:** Single writer for the contribution directory tree. Owns the layout, owns the index, owns concurrency.

**Storage layout:**
```
/home/james/projects/sovren/notes/methodology-contributions/
├── index.json
└── <contributor-slug>/
    └── <YYYY-MM-DD>-<slug>/
        ├── source.xlsx           # original file, untouched
        ├── xlsx-structure.json   # deterministic parse
        ├── methodology.json      # LLM-derived structured contribution
        ├── methodology.md        # human-readable companion
        ├── cover.md              # accompanying chat / email text
        └── links.json            # which SOVREN code files this affects
```

**Index (`index.json`):**
```typescript
interface ContributionIndex {
  contributions: ContributionEntry[];
}

interface ContributionEntry {
  id: string; // <contributor-slug>/<YYYY-MM-DD>-<slug>
  contributor: string;
  receivedAt: string;
  fileName: string;
  fileHash: string;
  status: 'pending' | 'under_review' | 'incorporated' | 'rejected' | 'superseded';
  affects: string[]; // SOVREN code paths from links.json
  supersedes: string | null; // id of previous contribution this replaces
  shortDescription: string; // one-line summary for the morning report
}
```

**Operations:**
- `addContribution(structure, methodology, sourceFile, coverText)` — atomic write of the directory tree, append to index.
- `findByContributor(name)` → list
- `findByAffects(codePath)` → list (used by overnight cross-reference)
- `markStatus(id, status)` — only mutation allowed on existing contributions; the data files themselves are immutable once written. Status transitions go through here.
- `linkSupersedes(newId, oldId)` — when a v2 arrives, mark the v1 as superseded and update the index.

**Concurrency:** single-writer assumption (clawdbot is the only process writing to this tree). Reads are file-system reads with no locking. Writes are full-file rewrites of `index.json` after each addition.

### 6.4 `contribution-cross-reference` overnight task (clawdbot, new)

**Location:** `src/tasks/contribution-cross-reference.js`

**Purpose:** Once per night, walk the SOVREN git mirror's recent commits, identify which files changed, look up affected contributions in the index, emit an event into the existing morning-report event log.

**Schedule:** hooks into the existing overnight pipeline at the OPERATIONS stage (see compound-dream spec). Not a new schedule.

**Event shape:**
```typescript
interface ContributionsAffectedEvent {
  type: 'sovren_contributions_affected';
  date: string;
  changedFiles: string[];
  affectedContributions: {
    id: string;
    contributor: string;
    description: string;
    fileChanges: string[];
  }[];
}
```

**Morning report:** `briefing.js` reads this event (if present) and renders a "SOVREN contributions affected by overnight code changes" paragraph. No new code path, just a new event type.

### 6.5 Extension to `document-handler.js`

A new branch in `processDocument()` for the xlsx mimetype:
- `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (.xlsx)
- `application/vnd.ms-excel` (.xls — exceljs reads via legacy path)
- `text/csv` is already handled as text — leave alone.

The new branch:
1. Calls `XlsxParser.parse(buffer, fileName)` → `XlsxStructure`
2. Determines whether this is a SOVREN-context contribution. The check is:
   - **(a)** chat JID is in the SOVREN group registry (`groups.sovren.chatJid`), OR
   - **(b)** sender is James AND the filename contains the string `sovren` (case-insensitive)
   The two branches are independent — either qualifies.
3. If a SOVREN-context contribution: calls `MethodologyExtractor.extract(structure, messageText, senderName, currentMethodology)` → `MethodologyContribution`, then `ContributionStore.addContribution(...)` to persist.
4. If not a SOVREN-context contribution: skip the methodology pass and the contribution store. Build a flat text summary of the structural parse for context injection.
5. In both cases, return enriched messageText so the existing reply path can use it.

Step 2's gate keeps the contribution store focused on actual SOVREN methodology contributions and avoids polluting it with random spreadsheets.

---

## 7. Data flow on a real contribution

Walking through Peter's `Arbitration Award Sovren Template.xlsx` end-to-end:

1. Peter's WhatsApp message arrives with the xlsx attachment.
2. `message-handler.js` extracts `docInfo = { mimetype: 'application/vnd.openxmlformats...', fileName: 'Arbitration Award Sovren Template.xlsx' }`.
3. The follow-up window fix (separate spec) ensures the message is processed even without `@Clint` mention, because Peter is the same sender Clint just replied to and the window is open.
4. `processDocument()` matches the xlsx mimetype, downloads the buffer.
5. `XlsxParser.parse(buffer, 'Arbitration Award Sovren Template.xlsx')`:
   - Loads with `exceljs`
   - Walks every sheet, every non-empty cell
   - Captures formulas, computed values, number formats, merged ranges, defined names
   - Computes sha256 hash of the original buffer
   - Returns `XlsxStructure`
6. `MethodologyExtractor.extract(structure, coverText, 'Peter', existingMethodology)`:
   - Loads the existing SOVREN methodology spec from project knowledge (`project_read` for `sovren/plan.md` etc.)
   - Builds an EVO 30B prompt: "Here is the existing SOVREN spec. Here is a contributor's spreadsheet structure. Here is their cover note. Produce a structured methodology JSON conforming to this schema. Identify variables, formulas, dependencies, conflicts with the existing spec, and open questions."
   - Single LLM call. Validates against the schema. On success, returns `MethodologyContribution`.
7. `ContributionStore.addContribution(...)`:
   - Slugifies contributor: `peter`
   - Slugifies title: `arbitration-award-sovren-template`
   - Path: `/home/james/projects/sovren/notes/methodology-contributions/peter/2026-04-11-arbitration-award-sovren-template/`
   - Writes `source.xlsx`, `xlsx-structure.json`, `methodology.json`, `methodology.md`, `cover.md`, `links.json` (initially empty; James approves links later via the console)
   - Appends to `index.json` with status `pending`
8. The enriched `messageText` returned to `message-handler.js` includes the methodology summary, and the existing claude.js path generates a substantive reply that quotes the specific row anchors and asks Peter the open questions extracted in step 6.
9. project_sync picks up the new files on the next run. Clint can now read them via `project_read sovren` and `project_file_read sovren notes/methodology-contributions/peter/2026-04-11-arbitration-award-sovren-template/methodology.json`.
10. Three months later, when James asks "what did Peter say about the S-factor weighting", Clint reads `methodology.json`, finds the variable spec for `S_Factor`, and answers with the cell address and the contributor's stated definition — not a paraphrase.
11. When SOVREN backend code is updated to change the IRR discount, the overnight cross-reference task notices that `valuations.py` was touched, looks up which contributions list `valuations.py` in their `links.json`, and surfaces Peter's contribution in the next morning report as "Peter's two-component-average construction may need re-validation against the new IRR logic in valuations.py".

---

## 8. Today's specific recovery: the Excel that's already trapped

Peter's spreadsheet was forwarded by James at 22:04 BST on 2026-04-11 but never processed (no `.xlsx` support, no follow-up window). Once this spec is implemented:

1. James re-forwards the file to Clint in the SOVREN group with `@Clint` mention OR in DM.
2. The new path runs end-to-end as above.
3. The contribution is stored, the methodology JSON is built, and Clint's substantive reply replaces the holding message I sent earlier.

The retroactive case does not need a separate code path. The implementation simply needs to be deployed before James forwards again.

---

## 9. Hot-path latency budget

`xlsx` parsing for a typical contributor spreadsheet (a handful of sheets, hundreds of cells) is single-digit milliseconds in `exceljs`. The structural parse adds negligible latency.

The methodology extraction is one EVO 30B call, typically 5-15 seconds depending on prompt size. This is comparable to the existing Granite-Docling PDF parse path and falls inside the same "send a brief acknowledgement, then the substantive answer" pattern from the group participation spec (§6.3).

Implementation rule: on a methodology contribution, send a one-line acknowledgement immediately ("Got the spreadsheet, parsing and cross-checking against the existing spec — back in a few seconds"), run the methodology pass, then send the substantive reply with the methodology summary.

---

## 10. Failure modes and recovery

### 10.1 xlsx parse failure
If `exceljs` throws on a malformed file: log with context, store the raw file under the contribution directory with an `xlsx-parse-failed.txt` marker, reply in chat acknowledging the file was received but could not be parsed, suggest the contributor send a freshly exported version.

### 10.2 Methodology extraction failure (LLM produces invalid JSON)
The structural parse is still stored. The contribution directory is still created. An `extraction-failed.txt` records the raw model output. Clint replies with a structural summary (sheet names, cell counts) but no methodology summary. James can re-run the methodology extraction later via a console action.

### 10.3 EVO 30B unreachable
Same as 10.2 — store the structural parse, skip the methodology pass, queue a retry through the existing memory-queue infrastructure.

### 10.4 Index corruption
`index.json` is the only mutable file. On every write, the previous version is renamed to `index.json.prev` first. On load, if `index.json` fails to parse, fall back to `index.json.prev` and log a warning.

### 10.5 Duplicate contribution (same file hash)
If a file with an identical hash to an existing contribution is received, do not create a new directory. Reply acknowledging the duplicate and pointing the contributor to the existing entry's id.

### 10.6 Versioning (v1 → v2 of the same model)
The contributor sends a new spreadsheet that supersedes an earlier one. Detection is heuristic at first: same contributor, same fileName, hash differs. Clint asks "this looks like a new version of `<earlier contribution>` — should I link them?". On confirmation, the new contribution is created and its `supersedes` field is set; the old one's status flips to `superseded`. The old data is preserved in place.

---

## 11. Console / observability

Out of scope for this spec. Tracking added to a follow-up:
- A "SOVREN Contributions" tab in the Clint Console listing all contributions with status, contributor, date, affected code paths
- Approve / link buttons to flip status and edit `links.json` without touching the file system manually

For now, the contribution store is read by Clint and James through normal `project_file_read` and direct file access on EVO. The morning report is the operator-facing surface.

---

## 12. Out of scope

This spec does not:

- Add xlsx parsing to SOVREN's `extraction_service.py`. Award documents stay PDF/DOCX. Methodology contributions stay xlsx in clawdbot.
- Build a contributor login or web upload form. WhatsApp is the only channel.
- Add automatic merging of contributions into SOVREN code. Every code change is still manual and James-controlled. The store records contributions; humans incorporate them.
- Change the existing PDF / DOCX paths in `document-handler.js`. Those are untouched.
- Build a separate authentication or permissions layer for the contribution store. The existing group security (project mode, allowed contributors) is the only gate.
- Address voice-call ingest or any non-document contribution type.

---

## 13. Success criteria

The design is successful if:

1. A contributor drops an xlsx in the SOVREN WhatsApp group, and within 30 seconds Clint sends a substantive reply that quotes specific cell addresses and formulas from the file.
2. Three months later, asking Clint "what did Peter say about X" returns an answer with citations to specific cells from Peter's contribution, not a paraphrase from chat history.
3. When SOVREN backend code is changed and the change touches a path listed in any contribution's `links.json`, the next morning report flags the affected contributions.
4. The deterministic structural parse is reproducible byte-for-byte from the source file. Re-running the parser on the same file two months later produces the same `xlsx-structure.json`.
5. Methodology extraction failure does not lose the contribution — the structural parse is always stored.
6. No chat-log paraphrase of a contribution is ever the canonical record. The structural parse and methodology JSON are.

---

## 14. Implementation note

The order of work matters because Peter is waiting and James wants the trapped Excel processed:

1. **First:** `XlsxParser` + the new branch in `document-handler.js`. This is enough to ingest the trapped Excel and get a structural parse back.
2. **Second:** `ContributionStore` (writes the directory tree, no LLM dependency).
3. **Third:** `MethodologyExtractor` and the EVO 30B prompt. This is the highest-value step but also the most likely to need iteration.
4. **Fourth:** the overnight cross-reference task. Lowest urgency, highest leverage long-term.

Phases 1-3 can ship in a single deployment. Phase 4 ships after the morning report has rendered at least one cycle of contribution data without errors.

The deployment of phases 1-3 unblocks James forwarding the trapped Excel and getting a substantive Clint reply in real time.
