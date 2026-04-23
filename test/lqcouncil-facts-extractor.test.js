// test/lqcouncil-facts-extractor.test.js — parse bot-council source → facts.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';

const {
  parseRolesFromTypes,
  parseErrorKinds,
  parseRoundCount,
  parseRoundTimeoutSeconds,
  parseApiRoutes,
  parseClaudeMdStructure,
  walkSvelteKitRoutes,
  fetchFrontendRoutesFromGithub,
  extractFactsFromCheckout,
  diffSnapshots,
} = await import('../src/lqcouncil/facts-extractor.js');

describe('parseRolesFromTypes', () => {
  it('extracts the five current roles in source order as snake_case', () => {
    const source = `
      #[derive(Debug)]
      pub enum Role {
        Proponent,
        Skeptic,
        DevilsAdvocate,
        Empiricist,
        Steelman,
      }
    `;
    assert.deepEqual(parseRolesFromTypes(source), [
      'proponent', 'skeptic', 'devils_advocate', 'empiricist', 'steelman',
    ]);
  });

  it('returns empty when no Role enum is present', () => {
    assert.deepEqual(parseRolesFromTypes('pub struct Other {}'), []);
  });

  it('tolerates line comments between variants', () => {
    const source = `pub enum Role {
      Proponent, // strong case
      Skeptic,
    }`;
    assert.deepEqual(parseRolesFromTypes(source), ['proponent', 'skeptic']);
  });

  it('detects a new role added between existing ones', () => {
    const source = `pub enum Role {
      Proponent,
      Skeptic,
      Moderator,
      DevilsAdvocate,
      Empiricist,
      Steelman,
    }`;
    assert.deepEqual(parseRolesFromTypes(source), [
      'proponent', 'skeptic', 'moderator', 'devils_advocate', 'empiricist', 'steelman',
    ]);
  });
});

describe('parseErrorKinds', () => {
  it('collects unique kind: "…" literals', () => {
    const source = `
      return ErrorClassification { kind: "timeout", detail: "x".into() };
      return ErrorClassification { kind: "http_5xx", detail: format!("HTTP {}", s) };
      return ErrorClassification { kind: "timeout", detail: "y".into() }; // dup
    `;
    assert.deepEqual(parseErrorKinds(source), ['http_5xx', 'timeout']);
  });

  it('returns empty when no literals present', () => {
    assert.deepEqual(parseErrorKinds('// no kinds here'), []);
  });
});

describe('parseRoundCount', () => {
  it('converts `0..=4` to round count 5', () => {
    assert.equal(parseRoundCount('for round in 0..=4 {'), 5);
  });

  it('detects a 7-round expansion', () => {
    assert.equal(parseRoundCount('for round in 0..=6 {'), 7);
  });

  it('returns null when pattern missing', () => {
    assert.equal(parseRoundCount('fn run() {}'), null);
  });
});

describe('parseRoundTimeoutSeconds', () => {
  it('reads config.toml style decl', () => {
    assert.equal(parseRoundTimeoutSeconds('timeout_secs = 300'), 300);
  });

  it('reads rust const', () => {
    assert.equal(parseRoundTimeoutSeconds('const DEFAULT_TIMEOUT_SECS: u64 = 180;'), 180);
  });
});

describe('extractFactsFromCheckout', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lqc-facts-'));
    mkdirSync(join(tmpDir, 'src', 'orchestrator'), { recursive: true });
    mkdirSync(join(tmpDir, 'config'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'src', 'types.rs'),
      'pub enum Role { Proponent, Skeptic, DevilsAdvocate, Empiricist, Steelman }',
    );
    writeFileSync(
      join(tmpDir, 'src', 'orchestrator', 'error_kind.rs'),
      'kind: "timeout", kind: "http_5xx", kind: "internal"',
    );
    writeFileSync(
      join(tmpDir, 'src', 'orchestrator', 'state_machine.rs'),
      'for round in 0..=4 { run_round(round).await?; }',
    );
    writeFileSync(join(tmpDir, 'config', 'default.toml'), 'timeout_secs = 300');
  });

  after(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it('pulls all four structural facts from a realistic checkout', async () => {
    const snap = await extractFactsFromCheckout(tmpDir, { fetchFn: async () => ({ ok: false }) });
    assert.equal(snap.sourceAvailable, true);
    assert.deepEqual(snap.roles, ['proponent', 'skeptic', 'devils_advocate', 'empiricist', 'steelman']);
    assert.deepEqual(snap.errorKinds, ['http_5xx', 'internal', 'timeout']);
    assert.equal(snap.roundCount, 5);
    assert.equal(snap.roundTimeoutSeconds, 300);
  });

  it('adds empty api/claude/frontend fields when their sources are missing', async () => {
    const snap = await extractFactsFromCheckout(tmpDir, { fetchFn: async () => ({ ok: false }) });
    assert.deepEqual(snap.apiRoutes, []);
    assert.deepEqual(snap.claudeMd, { sections: [], urls: [], hash: null });
    assert.equal(snap.frontendRoutes, null);
  });

  it('extracts apiRoutes + claudeMd when those files exist', async () => {
    mkdirSync(join(tmpDir, 'src', 'api'), { recursive: true });
    writeFileSync(join(tmpDir, 'src', 'api', 'mod.rs'),
      `Router::new()\n.route("/health", get(health::health))\n.route("/bots", get(bots::list).post(bots::create))\n`);
    writeFileSync(join(tmpDir, 'CLAUDE.md'),
      '# Bot Council\n\n## Quick Reference\n\nSee https://lqcouncil.com for details.\n');
    const snap = await extractFactsFromCheckout(tmpDir, { fetchFn: async () => ({ ok: false }) });
    assert.deepEqual(snap.apiRoutes, [
      { path: '/bots', methods: ['get', 'post'] },
      { path: '/health', methods: ['get'] },
    ]);
    assert.deepEqual(snap.claudeMd.sections, ['Bot Council', 'Quick Reference']);
    assert.deepEqual(snap.claudeMd.urls, ['https://lqcouncil.com']);
    assert.ok(snap.claudeMd.hash && snap.claudeMd.hash.length === 64);
  });

  it('extracts frontendRoutes from a local SvelteKit tree when present', async () => {
    mkdirSync(join(tmpDir, 'frontend', 'src', 'routes', 'bots', 'guide'), { recursive: true });
    mkdirSync(join(tmpDir, 'frontend', 'src', 'routes', 'bots', '[id]', 'test'), { recursive: true });
    writeFileSync(join(tmpDir, 'frontend', 'src', 'routes', '+layout.svelte'), '');
    writeFileSync(join(tmpDir, 'frontend', 'src', 'routes', 'bots', 'guide', '+page.svelte'), '');
    writeFileSync(join(tmpDir, 'frontend', 'src', 'routes', 'bots', '[id]', 'test', '+page.svelte'), '');
    const snap = await extractFactsFromCheckout(tmpDir, { fetchFn: async () => ({ ok: false }) });
    assert.ok(snap.frontendRoutes.includes('/'));
    assert.ok(snap.frontendRoutes.includes('/bots/guide'));
    assert.ok(snap.frontendRoutes.includes('/bots/[id]/test'));
    assert.equal(snap.frontendRoutesSource, 'local');
  });

  it('falls back to GitHub when local frontend source is absent', async () => {
    const fakeTree = {
      tree: [
        { type: 'blob', path: 'frontend/src/routes/+layout.svelte' },
        { type: 'blob', path: 'frontend/src/routes/bots/guide/+page.svelte' },
        { type: 'blob', path: 'frontend/src/routes/bots/[id]/test/+page.svelte' },
        { type: 'blob', path: 'unrelated/file.rs' },
      ],
    };
    const fetchFn = async (url) => ({ ok: true, json: async () => fakeTree });
    const snap = await extractFactsFromCheckout(tmpDir, { fetchFn });
    assert.equal(snap.frontendRoutesSource, 'github');
    assert.deepEqual(snap.frontendRoutes.sort(), ['/', '/bots/[id]/test', '/bots/guide']);
  });

  it('flags sourceAvailable=false when directory is missing', async () => {
    const snap = await extractFactsFromCheckout(join(tmpDir, 'does-not-exist'));
    assert.equal(snap.sourceAvailable, false);
  });
});

describe('parseApiRoutes', () => {
  it('extracts path + methods from inline .route() calls', () => {
    const src = `Router::new()
      .route("/health", get(health::health))
      .route("/bots", get(bots::list).post(bots::create))
      .route("/debates/{id}", delete(debates::remove))`;
    assert.deepEqual(parseApiRoutes(src), [
      { path: '/bots', methods: ['get', 'post'] },
      { path: '/debates/{id}', methods: ['delete'] },
      { path: '/health', methods: ['get'] },
    ]);
  });

  it('handles multiline .route() blocks', () => {
    const src = `Router::new()
      .route(
        "/debates",
        get(debates::list).post(debates::create),
      )
      .route("/health", get(health::health))`;
    const routes = parseApiRoutes(src);
    assert.deepEqual(routes.find((r) => r.path === '/debates').methods, ['get', 'post']);
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(parseApiRoutes(''), []);
    assert.deepEqual(parseApiRoutes(null), []);
  });
});

describe('parseClaudeMdStructure', () => {
  it('extracts H1/H2 sections, URLs, and a stable hash', () => {
    const md = `# Top
## Sub
### Skipped
See https://a.example/foo and [docs](https://b.example/bar).
Trailing: https://c.example.`;
    const out = parseClaudeMdStructure(md);
    assert.deepEqual(out.sections, ['Top', 'Sub']);
    assert.deepEqual(out.urls, ['https://a.example/foo', 'https://b.example/bar', 'https://c.example']);
    assert.ok(out.hash && out.hash.length === 64);
  });

  it('is deterministic — same content, same hash', () => {
    const a = parseClaudeMdStructure('hello world');
    const b = parseClaudeMdStructure('hello world');
    assert.equal(a.hash, b.hash);
  });

  it('returns empties and null hash for missing content', () => {
    assert.deepEqual(parseClaudeMdStructure(''), { sections: [], urls: [], hash: null });
    assert.deepEqual(parseClaudeMdStructure(null), { sections: [], urls: [], hash: null });
  });
});

describe('walkSvelteKitRoutes', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sv-routes-')); });

  it('returns null when the directory does not exist', () => {
    assert.equal(walkSvelteKitRoutes(join(tmp, 'nope')), null);
  });

  it('collects routes only where a +page marker exists', () => {
    mkdirSync(join(tmp, 'a'), { recursive: true });
    writeFileSync(join(tmp, 'a', '+page.svelte'), '');
    mkdirSync(join(tmp, 'b'), { recursive: true });
    // b has no marker — should not appear
    mkdirSync(join(tmp, 'c'), { recursive: true });
    writeFileSync(join(tmp, 'c', '+server.ts'), '');
    const out = walkSvelteKitRoutes(tmp);
    assert.deepEqual(out, ['/a', '/c']);
  });

  it('strips SvelteKit (group) segments from URLs', () => {
    mkdirSync(join(tmp, '(auth)', 'login'), { recursive: true });
    writeFileSync(join(tmp, '(auth)', 'login', '+page.svelte'), '');
    const out = walkSvelteKitRoutes(tmp);
    assert.deepEqual(out, ['/login']);
  });
});

describe('fetchFrontendRoutesFromGithub', () => {
  it('parses the tree response into route paths', async () => {
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({
        tree: [
          { type: 'blob', path: 'frontend/src/routes/+page.svelte' },
          { type: 'blob', path: 'frontend/src/routes/bots/guide/+page.svelte' },
          { type: 'blob', path: 'frontend/src/routes/(auth)/login/+page.svelte' },
          { type: 'tree', path: 'frontend/src/routes/bots' },
          { type: 'blob', path: 'src/main.rs' },
        ],
      }),
    });
    const out = await fetchFrontendRoutesFromGithub({ owner: 'o', repo: 'r', fetchFn });
    assert.deepEqual(out.sort(), ['/', '/bots/guide', '/login']);
  });

  it('returns null on non-OK response', async () => {
    const fetchFn = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const out = await fetchFrontendRoutesFromGithub({ owner: 'o', repo: 'r', fetchFn });
    assert.equal(out, null);
  });

  it('returns null on network throw', async () => {
    const fetchFn = async () => { throw new Error('offline'); };
    const out = await fetchFrontendRoutesFromGithub({ owner: 'o', repo: 'r', fetchFn });
    assert.equal(out, null);
  });

  it('returns null when owner/repo is missing', async () => {
    assert.equal(await fetchFrontendRoutesFromGithub({}), null);
  });
});

describe('diffSnapshots', () => {
  const baseline = {
    sourceAvailable: true,
    repoRoot: '/x',
    roles: ['proponent', 'skeptic'],
    errorKinds: ['timeout', 'internal'],
    roundCount: 5,
    roundTimeoutSeconds: 300,
    apiRoutes: [
      { path: '/bots', methods: ['get', 'post'] },
      { path: '/health', methods: ['get'] },
    ],
    claudeMd: { sections: ['A', 'B'], urls: ['https://x.example'], hash: 'a'.repeat(64) },
    frontendRoutes: ['/', '/bots/guide'],
    frontendRoutesSource: 'local',
  };

  it('reports initial-snapshot when no prior exists', () => {
    const out = diffSnapshots(null, baseline);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'initial-snapshot');
  });

  it('returns empty array when snapshots are identical', () => {
    assert.deepEqual(diffSnapshots(baseline, baseline), []);
  });

  it('flags role added + error kind removed', () => {
    const next = { ...baseline, roles: ['proponent', 'skeptic', 'moderator'], errorKinds: ['timeout'] };
    const out = diffSnapshots(baseline, next);
    const roles = out.find((c) => c.field === 'roles');
    const errs = out.find((c) => c.field === 'errorKinds');
    assert.deepEqual(roles.added, ['moderator']);
    assert.deepEqual(errs.removed, ['internal']);
  });

  it('flags scalar change in round count', () => {
    const next = { ...baseline, roundCount: 7 };
    const out = diffSnapshots(baseline, next);
    const scalar = out.find((c) => c.kind === 'scalar-diff');
    assert.equal(scalar.field, 'roundCount');
    assert.equal(scalar.old, 5);
    assert.equal(scalar.new, 7);
  });

  it('detects api route added, removed, and method changed', () => {
    const next = {
      ...baseline,
      apiRoutes: [
        { path: '/bots', methods: ['get', 'post', 'patch'] },   // method added
        { path: '/debates', methods: ['get'] },                 // new route
        // /health removed
      ],
    };
    const out = diffSnapshots(baseline, next);
    const diff = out.find((c) => c.kind === 'api-routes-diff');
    assert.ok(diff, 'expected api-routes-diff');
    assert.ok(diff.added.some((r) => r.includes('/debates')));
    assert.ok(diff.removed.some((r) => r.includes('/health')));
    assert.ok(diff.changed.some((r) => r.includes('/bots')));
  });

  it('promotes CLAUDE.md URL changes to array-diff (high-signal)', () => {
    const next = { ...baseline, claudeMd: { ...baseline.claudeMd, urls: ['https://y.example'], hash: 'b'.repeat(64) } };
    const out = diffSnapshots(baseline, next);
    const urlDiff = out.find((c) => c.field === 'claudeMd.urls');
    assert.ok(urlDiff);
    assert.deepEqual(urlDiff.added, ['https://y.example']);
    assert.deepEqual(urlDiff.removed, ['https://x.example']);
    // hash-only should NOT fire when urls also changed
    assert.equal(out.find((c) => c.kind === 'claude-md-hash-only'), undefined);
  });

  it('records claude-md-hash-only when only bytes changed', () => {
    const next = { ...baseline, claudeMd: { ...baseline.claudeMd, hash: 'b'.repeat(64) } };
    const out = diffSnapshots(baseline, next);
    const hashOnly = out.find((c) => c.kind === 'claude-md-hash-only');
    assert.ok(hashOnly);
  });

  it('records frontend-source-unavailable without treating as drift', () => {
    const next = { ...baseline, frontendRoutes: null };
    const out = diffSnapshots(baseline, next);
    const unavailable = out.find((c) => c.kind === 'frontend-source-unavailable');
    assert.ok(unavailable);
    assert.equal(unavailable.previousCount, 2);
  });

  it('records frontend-routes-first-snapshot when previously null', () => {
    const prior = { ...baseline, frontendRoutes: null };
    const out = diffSnapshots(prior, baseline);
    const first = out.find((c) => c.kind === 'frontend-routes-first-snapshot');
    assert.ok(first);
    assert.equal(first.count, 2);
    assert.equal(first.source, 'local');
  });

  it('detects frontend route add', () => {
    const next = { ...baseline, frontendRoutes: ['/', '/bots/guide', '/bots/[id]/test'] };
    const out = diffSnapshots(baseline, next);
    const feDiff = out.find((c) => c.field === 'frontendRoutes');
    assert.ok(feDiff);
    assert.deepEqual(feDiff.added, ['/bots/[id]/test']);
  });
});
