# Participation Settings Console — Design Spec

**Date:** 2026-04-12
**Status:** Approved
**Scope:** Runtime-tunable participation/agency parameters via Clint Console, with immediate effect (no restart).

---

## Problem

All participation and agency tuning parameters are hardcoded constants (`Object.freeze()` in `policy.js`, `PARTICIPATION_DEFAULTS` in `constants.ts`). Changing Clint's group behaviour requires code changes and a service restart. James needs to adjust these on the fly from the console.

## Architecture

### Principle: Merge-on-read from a single persisted store

Extend the existing `data/runtime/group-participation.json` file (already used by `policy-service.ts`) to also store agency policy overrides. The bot reads this file fresh on every inbound message — no restart, no cache invalidation, no file watchers needed.

Hardcoded constants remain as defaults. Runtime overrides are merged on top. If a field is absent from the override, the default applies.

### Data model

```json
{
  "version": 1,
  "overrides": {
    "120363407496928531@g.us": {
      "posture": "active_participant",
      "researchEnabled": true,
      "memoryRecallEnabled": true,
      "maxUnsolicitedPerHour": 3,
      "followUpWindowMs": 300000,
      "cooldownMs": 60000
    }
  },
  "agencyPolicies": {
    "lqcore": {
      "enabled": true,
      "minHeuristicScore": 6,
      "minModelConfidence": 0.85,
      "cooldownMs": 300000,
      "maxInterventionsPerHour": 3,
      "maxFollowUpTurns": 3
    },
    "sovren": {
      "enabled": true,
      "minHeuristicScore": 2,
      "minModelConfidence": 0.65,
      "cooldownMs": 120000,
      "maxInterventionsPerHour": 14,
      "maxFollowUpTurns": 3
    }
  }
}
```

### Tunable parameters

**Per-group participation profile** (keyed by chatJid in `overrides`):

| Parameter | Type | Range | Default | Effect |
|-----------|------|-------|---------|--------|
| posture | enum | direct_only / rare_high_confidence / active_participant | direct_only | Controls ambient willingness |
| researchEnabled | boolean | — | true | Allow web search in ambient |
| memoryRecallEnabled | boolean | — | true | Allow memory recall in ambient |
| maxUnsolicitedPerHour | number | 1–20 | 2 | Hard cap on unsolicited per hour |
| followUpWindowMs | number | 60000–600000 | 300000 | Follow-up window duration |
| cooldownMs | number | 30000–600000 | 60000 | Min gap between responses in group |

**Per-group-label agency policy** (keyed by lowercase group label in `agencyPolicies`):

| Parameter | Type | Range | Default (LQCore) | Effect |
|-----------|------|-------|-------------------|--------|
| enabled | boolean | — | true | Master switch for ambient agency |
| minHeuristicScore | number | 1–10 | 6 | Heuristic score floor |
| minModelConfidence | number | 0.50–1.00 | 0.85 | ML classifier confidence floor |
| cooldownMs | number | 60000–600000 | 300000 | Agency-specific cooldown |
| maxInterventionsPerHour | number | 1–20 | 3 | Agency-specific hourly cap |
| maxFollowUpTurns | number | 1–5 | 3 | Follow-up turn hard cap |

---

## Bot-side changes

### 1. Unfreeze agency policy — `src/agency/policy.js`

Replace frozen constant lookup with merge-on-read:

- Hardcoded defaults remain as `const DEFAULT_LQCORE_POLICY = { ... }` (not frozen, or frozen as fallback only).
- `getAmbientAgencyConfig({ groupLabel })` reads `agencyPolicies[label]` from the persisted store via a new function in `policy-service.ts`, then merges onto the hardcoded default.
- If no override exists, returns the hardcoded default (current behaviour).

### 2. Make maxFollowUpTurns configurable — `src/participation/constants.ts`

`MAX_FOLLOW_UP_TURNS_PER_WINDOW` is currently a module-level `const` = 3. Change `engagement-service.ts` to read this from the resolved participation profile rather than the constant. The constant becomes the default fallback.

### 3. New HTTP endpoints — `src/http-server.js`

**`GET /api/participation/config`**

Returns the full resolved config for all ambient-enabled groups:

```json
{
  "groups": [
    {
      "chatJid": "120363407496928531@g.us",
      "label": "LQCore",
      "mode": "open",
      "participation": {
        "posture": "active_participant",
        "researchEnabled": true,
        "memoryRecallEnabled": true,
        "maxUnsolicitedPerHour": 3,
        "followUpWindowMs": 300000,
        "cooldownMs": 60000
      },
      "agency": {
        "enabled": true,
        "minHeuristicScore": 6,
        "minModelConfidence": 0.85,
        "cooldownMs": 300000,
        "maxInterventionsPerHour": 3,
        "maxFollowUpTurns": 3
      }
    }
  ],
  "defaults": {
    "participation": { /* PARTICIPATION_DEFAULTS */ },
    "agency": { /* DEFAULT_LQCORE_POLICY */ }
  }
}
```

**`PATCH /api/participation/groups/:jid`**

Body: partial `ParticipationOverride` object. Merges into `overrides[jid]` in the store, persists to disk, returns the updated resolved profile.

Validation: each field checked against its allowed range. Unknown fields rejected. Returns 400 with specific error on invalid input.

**`PATCH /api/participation/agency/:groupLabel`**

Body: partial agency policy object. Merges into `agencyPolicies[label]` in the store, persists to disk, returns the updated resolved policy.

Validation: same pattern — range checks, unknown field rejection, 400 on bad input.

### 4. Extend policy-service.ts

Add two new exported functions:

- `getAgencyPolicyOverride(groupLabel: string): Partial<AgencyPolicy> | null` — reads the `agencyPolicies` section from the persisted store.
- `mergeAgencyPolicy(groupLabel: string, patch: Partial<AgencyPolicy>): AgencyPolicy` — merges patch into stored override, persists, returns resolved policy.

Both follow the same file I/O pattern as `mergeParticipationProfile`.

### 5. Effect timing

All changes take effect on the next inbound message. The merge-on-read pattern in `policy-service.ts` already reads from disk on every call — no invalidation needed.

---

## Console-side changes

### 1. Groups page — inline quick toggles

On the existing `GroupDetail` component (right panel when a group is selected), add three inline controls below the existing read-only badges:

- **Posture** — `<select>` dropdown with three options. Current value pre-selected.
- **Ambient enabled** — toggle switch.
- **Max unsolicited/hour** — number stepper (1–20).

Each control fires `postPi('/api/participation/groups/:jid', { posture })` or `postPi('/api/participation/agency/:label', { enabled })` on change. Brief "Saved" toast/flash on success. No separate save button — changes apply immediately.

### 2. New Settings page — `(console)/settings/page.tsx`

Add to sidebar under "Control" group, after "Playbook".

**Layout:** Tabbed or accordion per group (only groups with ambient enabled). Each group section shows:

**Participation tuning:**
- Posture dropdown
- Follow-up window duration (dropdown: 2m, 3m, 5m, 10m)
- Max follow-up turns (stepper 1–5)
- Cooldown between responses (dropdown: 30s, 1m, 2m, 3m, 5m)
- Max unsolicited per hour (stepper 1–20)
- Research enabled (toggle)
- Memory recall enabled (toggle)

**Agency tuning:**
- Enabled (toggle)
- Min heuristic score (slider 1–10, integer)
- Min model confidence (slider 0.50–1.00, step 0.05)
- Agency cooldown (dropdown: 1m, 2m, 3m, 5m, 10m)
- Max interventions per hour (stepper 1–20)

**Defaults reference:** Collapsible section at the bottom showing the hardcoded defaults (read-only) so James knows what the baseline is.

**Recent rejections:** Filterable list of recent participation decisions with rejection reasons, pulled from `GET /api/participation/decisions?limit=50`. Helps diagnose whether parameters are too tight or too loose.

### 3. API client additions — `clawd-console/src/lib/api.ts`

```typescript
export function fetchParticipationConfig(): Promise<ParticipationConfig> {
  return fetchPi('/api/participation/config');
}

export function patchParticipationGroup(jid: string, patch: Partial<ParticipationOverride>): Promise<ParticipationProfile> {
  return patchPi(`/api/participation/groups/${encodeURIComponent(jid)}`, patch);
}

export function patchAgencyPolicy(label: string, patch: Partial<AgencyPolicy>): Promise<AgencyPolicy> {
  return patchPi(`/api/participation/agency/${encodeURIComponent(label)}`, patch);
}
```

Note: `patchPi` is a new helper alongside `fetchPi`/`postPi` that sends `method: 'PATCH'` through the existing `/api/pi/` proxy (which already supports PATCH).

### 4. Type definitions — `clawd-console/src/types/participation.ts`

New file with shared types for the config response, override shapes, and agency policy. Mirrors the bot-side types.

---

## Validation rules

All PATCH endpoints enforce:

| Field | Validation |
|-------|-----------|
| posture | Must be one of the three enum values |
| maxUnsolicitedPerHour | Integer, 1–20 |
| followUpWindowMs | Integer, 60000–600000 |
| cooldownMs | Integer, 30000–600000 |
| researchEnabled | Boolean |
| memoryRecallEnabled | Boolean |
| enabled | Boolean |
| minHeuristicScore | Integer, 1–10 |
| minModelConfidence | Number, 0.50–1.00 |
| maxInterventionsPerHour | Integer, 1–20 |
| maxFollowUpTurns | Integer, 1–5 |

Unknown fields in the PATCH body are rejected with 400.

## Out of scope

- Real-time SSE push of config changes to the console (manual refresh is fine; you're the one making the change).
- Undo/history of parameter changes (file is git-tracked via overnight backup; that's sufficient).
- Per-sender tuning (all settings are per-group or per-group-label).
- Editing the heuristic signal patterns or weights (those are code, not config).
- SOVREN-specific UI (same controls, just different default values — falls out naturally from the per-label design).

## File changes summary

**Bot (EVO):**
- `src/agency/policy.js` — unfreeze, merge-on-read from store
- `src/participation/policy-service.ts` — add agency policy read/merge functions
- `src/participation/constants.ts` — maxFollowUpTurns becomes a default, not a hard constant
- `src/participation/engagement-service.ts` — read maxFollowUpTurns from profile
- `src/http-server.js` — three new endpoints (GET config, PATCH groups, PATCH agency)

**Console (Legion):**
- `clawd-console/src/app/(console)/groups/page.tsx` — add inline quick toggles
- `clawd-console/src/app/(console)/settings/page.tsx` — new page
- `clawd-console/src/components/layout/sidebar.tsx` — add Settings nav item
- `clawd-console/src/lib/api.ts` — three new API functions
- `clawd-console/src/types/participation.ts` — new types file
