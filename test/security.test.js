import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

function getJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      files.push(...getJsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

describe('secret exposure', () => {
  const srcFiles = getJsFiles(SRC);
  const rootJsFiles = readdirSync(ROOT)
    .filter((f) => f.endsWith('.js'))
    .map((f) => join(ROOT, f));
  const allFiles = [...srcFiles, ...rootJsFiles];

  it('no hardcoded API keys in source files', () => {
    const patterns = [
      /sk-[a-zA-Z0-9]{20,}/,          // Anthropic API key
      /GOCSPX-[a-zA-Z0-9_-]+/,        // Google OAuth client secret
      /AIza[a-zA-Z0-9_-]{35}/,        // Google API key
      /ya29\.[a-zA-Z0-9_-]+/,         // Google OAuth access token
      /1\/\/[a-zA-Z0-9_-]{40,}/,      // Google refresh token
    ];

    for (const file of allFiles) {
      const content = readFileSync(file, 'utf-8');
      for (const pattern of patterns) {
        const match = content.match(pattern);
        assert.ok(!match, `Potential secret found in ${file}: ${match?.[0]?.slice(0, 20)}...`);
      }
    }
  });

  it('no .env file committed in project root', () => {
    const envPath = join(ROOT, '.env');
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      assert.ok(!content.includes('sk-'), '.env contains what looks like an API key — ensure this is .gitignored');
    }
  });

  it('settings.local.json does not contain secrets', () => {
    const settingsPath = join(ROOT, '.claude', 'settings.local.json');
    if (existsSync(settingsPath)) {
      const content = readFileSync(settingsPath, 'utf-8');
      const hasClientSecret = /GOCSPX-[a-zA-Z0-9_-]+/.test(content);
      const hasClientId = /\d{12,}-[a-z0-9]+\.apps\.googleusercontent\.com/.test(content);
      if (hasClientSecret || hasClientId) {
        assert.fail(
          'settings.local.json contains OAuth credentials in plain text. '
          + 'These are visible in the permission allow list. '
          + 'Consider removing the specific Bash command that contains them '
          + 'and using environment variables instead.',
        );
      }
    }
  });
});

describe('input validation', () => {
  let TOOL_DEFINITIONS;

  before(async () => {
    const defs = await import('../src/tools/definitions.js');
    TOOL_DEFINITIONS = defs.TOOL_DEFINITIONS;
  });

  it('tool definitions use type constraints on all properties', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const props = tool.input_schema.properties || {};
      for (const [key, schema] of Object.entries(props)) {
        assert.ok(
          schema.type,
          `${tool.name}.${key} must have a type constraint`,
        );
      }
    }
  });

  it('gmail_draft body is string type (no injection via object)', () => {
    const draft = TOOL_DEFINITIONS.find((t) => t.name === 'gmail_draft');
    assert.equal(draft.input_schema.properties.body.type, 'string');
    assert.equal(draft.input_schema.properties.to.type, 'string');
    assert.equal(draft.input_schema.properties.subject.type, 'string');
  });
});

describe('OAuth scope alignment', () => {
  it('get-google-token.js uses minimal scopes', () => {
    const content = readFileSync(join(ROOT, 'get-google-token.js'), 'utf-8');

    assert.ok(content.includes('calendar.events'), 'must use calendar.events scope');
    assert.ok(!content.match(/auth\/calendar['",\s]/), 'must NOT use full calendar scope');

    assert.ok(content.includes('gmail.readonly'), 'must use gmail.readonly scope');
    assert.ok(!content.includes('gmail.modify'), 'must NOT use gmail.modify scope');

    assert.ok(content.includes('gmail.compose'), 'must use gmail.compose for draft support');
    assert.ok(!content.includes('mail.google.com'), 'must NOT use full mail access scope');
  });
});

describe('no dangerous operations exposed', () => {
  it('gmail.js does not call messages.delete or messages.trash', () => {
    const content = readFileSync(join(SRC, 'tools', 'gmail.js'), 'utf-8');
    assert.ok(!content.includes('.delete('), 'gmail.js must not call .delete()');
    assert.ok(!content.includes('.trash('), 'gmail.js must not call .trash()');
    assert.ok(!content.includes('.untrash('), 'gmail.js must not call .untrash()');
  });

  it('gmail.js only sends via drafts.send, not messages.send', () => {
    const content = readFileSync(join(SRC, 'tools', 'gmail.js'), 'utf-8');
    assert.ok(!content.includes('messages.send'), 'gmail.js must not use messages.send — only drafts.send');
    assert.ok(content.includes('drafts.send'), 'gmail.js must use drafts.send for the confirm flow');
  });

  it('calendar.js does not call events.delete', () => {
    const content = readFileSync(join(SRC, 'tools', 'calendar.js'), 'utf-8');
    assert.ok(!content.includes('.delete('), 'calendar.js must not call .delete()');
  });

  it('handler.js does not expose any delete/trash functions', () => {
    const content = readFileSync(join(SRC, 'tools', 'handler.js'), 'utf-8');
    const lower = content.toLowerCase();
    assert.ok(!lower.includes('delete'), 'handler.js must not reference delete');
    assert.ok(!lower.includes('trash'), 'handler.js must not reference trash');
  });
});

describe('URL construction safety', () => {
  it('travel.js encodes user inputs in URLs', () => {
    const content = readFileSync(join(SRC, 'tools', 'travel.js'), 'utf-8');
    assert.ok(content.includes('encodeURIComponent'), 'must encode user inputs in URL parameters');
  });
});
