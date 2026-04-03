# Skill Contract Reference

This document defines the interface contract for all Forge-built skills. Every skill MUST conform to this contract exactly. The Forge reviewer will reject any skill that violates it.

## Required Fields

### name
- Type: `string`
- Format: kebab-case, lowercase, no spaces
- Must be unique across the skill registry
- Example: `"unit-converter"`, `"dice-roller"`, `"quote-lookup"`

### description
- Type: `string`
- One line, max 120 characters
- Describes what the skill does, not how
- Example: `"Converts between common units of measurement"`

### version
- Type: `string`
- Format: semver (major.minor.patch)
- New skills start at `"1.0.0"`
- Patch: bug fix. Minor: new capability. Major: breaking change to canHandle scope.

### created
- Type: `string`
- Format: ISO 8601 date (`"YYYY-MM-DD"`)
- Set once at creation, never updated

### author
- Type: `string`
- Value: `"forge"` for autonomously created skills, `"human"` for manually created

### canHandle(msg, context)
- Type: `function`
- Parameters:
  - `msg` -- object with at minimum `{ body: string|null }`
  - `context` -- object with `{ jid, isOwner, isGroup, groupJid, pushName, quotedMessage }`
- Returns: `boolean` (strictly `true` or `false`, not truthy/falsy)
- Must be synchronous (no async, no promises)
- Must be pure (no side effects, no state mutation, no logging)
- Must handle null/undefined body gracefully (return `false`)
- Must be fast (under 1ms, no network calls, no file I/O)

### execute(msg, context)
- Type: `async function`
- Parameters: same as canHandle
- Returns: `string | null`
  - `string`: the skill's response (replaces normal chat response)
  - `null`: skill declines to handle (falls through to normal chat)
- Must never throw to caller. Internal errors must be caught and return `null`.
- May be async (network-free operations, memory reads)
- Timeout: 5 seconds max execution time

### selfExplanation
- Type: `string`
- Natural language description for Clawd's self-awareness system
- Written in first person as Clawd
- Example: `"I can convert between units like miles to kilometres, Celsius to Fahrenheit, and pounds to kilograms."`

### examples
- Type: `Array<{ input: string, output: string }>`
- Minimum 3 examples
- Show realistic user messages and expected responses
- Include at least one edge case

## Optional Fields

### triggers.categories
- Type: `string[]`
- Classifier categories that should route to this skill
- Example: `["UTILITY", "CALCULATION"]`
- If omitted, routing relies entirely on canHandle matching

### triggers.conditions
- Type: `object`
- Additional conditions beyond category matching
- Example: `{ isGroup: false }` (DM-only skill)
- If omitted, skill is available in all contexts

### metrics
- Type: `object`
- Shape: `{ invocations: number, successes: number, failures: number, avgLatencyMs: number }`
- Managed by the skill runner, not the skill itself
- Initialised to zeros at deployment

## Rules

### Augment, Never Replace
Skills augment Clawd's capabilities. They do not replace existing behaviour. If a skill's canHandle returns `true` but execute returns `null`, the original response pipeline continues as if the skill did not exist.

### Null and Throw Semantics
- `canHandle` returning `false` = skill does not apply
- `execute` returning `null` = skill applies but declines (original pipeline continues)
- `execute` throwing = BUG (caught by runner, logged, original pipeline continues)
- A skill must never break the bot. The runner treats all failures as graceful decline.

### No External APIs
Skills must not call external APIs (no HTTP requests, no third-party services). They may:
- Read from memory service (localhost:5100, read-only queries)
- Use built-in Node.js modules
- Perform local computation

### No Circular Dependencies
Skills must not import other skills. Skills are leaves in the dependency tree.

### Approved Imports
Skills CAN import from these modules only:
- `config.js` -- configuration values
- `constants.js` -- shared constants
- `logger.js` -- logging (info, warn, error)
- `memory.js` -- memory service client (read-only: search, get)

Skills CANNOT import from:
- `message-handler.js`
- `router.js`
- `classifier.js`
- `claude.js`
- `evo-client.js`
- Any file in `src/tasks/`
- Other skills

### File Structure
```
src/skills/
  registry.js        -- skill loader and lookup
  <skill-name>.js    -- one file per skill
tests/skills/
  test-<skill-name>.js -- one test file per skill
```

### Skill File Template
```js
// src/skills/<skill-name>.js
import config from '../config.js';
import logger from '../logger.js';

export default {
  name: '<skill-name>',
  description: '<one line>',
  version: '1.0.0',
  created: '<YYYY-MM-DD>',
  author: 'forge',

  canHandle(msg, context) {
    if (!msg?.body) return false;
    // matching logic
    return false;
  },

  async execute(msg, context) {
    try {
      // skill logic
      return 'response string';
    } catch (err) {
      logger.error(`[skill:<skill-name>] ${err.message}`);
      return null;
    }
  },

  selfExplanation: '<first person description>',

  examples: [
    { input: '<user message>', output: '<bot response>' },
  ],
};
```
