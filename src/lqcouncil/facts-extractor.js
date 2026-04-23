// src/lqcouncil/facts-extractor.js — pull authoritative structural facts
// from the bot-council repo source, for drift detection.
//
// Works against a checkout of jamescockburn47/bot-council (on EVO:
// /home/james/bot-council — synced nightly by project-sync).
//
// The goal is NOT to validate the curated knowledge is correct — it is
// to detect when the underlying source-of-truth changed so a human can
// review whether lqcouncil-knowledge.json needs re-curating. Cheap,
// deterministic, debuggable.
//
// v2 (2026-04-23) adds three fact classes beyond the original Rust
// structural parse:
//   - apiRoutes: the Axum route inventory from src/api/mod.rs (path +
//     methods). Deprecation, renames, and new endpoints all show up.
//   - claudeMd: sections (H1/H2), mentioned URLs, and content hash.
//     Tiered signal — URL change implies a probable endpoint move;
//     section change implies narrative restructure.
//   - frontendRoutes: SvelteKit filesystem routes from
//     frontend/src/routes/ when the directory exists locally; otherwise
//     pulled via the GitHub git-trees API (bot-council is public).
//     Null when both sources fail — logged but not an error.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, posix } from 'node:path';

/**
 * Parse the Role enum from src/types.rs. Returns snake_case names ordered
 * as they appear in the source (significant — that's the default rotation
 * pool order).
 */
export function parseRolesFromTypes(content) {
  const m = content.match(/pub\s+enum\s+Role\s*\{([\s\S]*?)\}/);
  if (!m) return [];
  const body = m[1];
  const variants = body
    .split(/[,\n]/)
    .map((s) => s.replace(/\/\/.*$/, '').trim())
    .filter((s) => s.length > 0 && /^[A-Z][A-Za-z0-9]*$/.test(s));
  return variants.map((v) => v.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());
}

/**
 * Parse error-kind string literals from src/orchestrator/error_kind.rs.
 * Returns sorted unique list.
 */
export function parseErrorKinds(content) {
  const matches = [...content.matchAll(/kind:\s*"([a-z0-9_]+)"/g)];
  return [...new Set(matches.map((m) => m[1]))].sort();
}

/**
 * Parse round count from src/orchestrator/state_machine.rs. Returns
 * integer (for `0..=4` returns 5).
 */
export function parseRoundCount(content) {
  const m = content.match(/for\s+round\s+in\s+0\.\.=\s*(\d+)/);
  if (!m) return null;
  return parseInt(m[1], 10) + 1;
}

/**
 * Parse per-round timeout seconds. Looks for config `default_timeout_secs`
 * or similar constants.
 */
export function parseRoundTimeoutSeconds(content) {
  // Search for decl like `default_timeout_secs: u64 = 300` or
  // `const DEFAULT_TIMEOUT_SECS: u64 = 300` or config.toml entry.
  const patterns = [
    /default_timeout_secs\s*[:=]\s*(?:u64\s*=\s*)?(\d+)/,
    /DEFAULT_TIMEOUT_SECS\s*:\s*u64\s*=\s*(\d+)/,
    /timeout_secs\s*=\s*(\d+)/,
  ];
  for (const re of patterns) {
    const m = content.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Parse Axum `.route("/path", method(handler))` declarations from
 * src/api/mod.rs. Handles chained method calls (`.get(h).post(h)`) and
 * multiline `.route(` blocks. Returns sorted array of
 * `{path, methods: ["get","post",...]}`. Path ordering is not
 * significant; methods are sorted for deterministic diff.
 */
export function parseApiRoutes(content) {
  if (!content) return [];
  // Flatten multiline route blocks: collapse newlines+whitespace after
  // `.route(` up to the closing `)` of the method chain, so the single
  // regex below works on either single- or multi-line forms.
  const flat = content.replace(/\.route\s*\(\s*/g, '.route("');
  // Restore the expected shape: `.route("` already present; find each
  // route block and parse within it.
  const routes = [];
  const routeRegex = /\.route\s*\(\s*"([^"]+)"\s*,\s*([\s\S]*?)\)\s*(?=\.(?:route|layer|with_state|nest|fallback)|\s*$|\s*;)/g;
  for (const m of content.matchAll(routeRegex)) {
    const path = m[1];
    const methodsBlock = m[2];
    const methodMatches = [...methodsBlock.matchAll(/\b(get|post|patch|delete|put|head|options)\s*\(/g)];
    const methods = [...new Set(methodMatches.map((mm) => mm[1].toLowerCase()))].sort();
    if (methods.length > 0) {
      routes.push({ path, methods });
    }
  }
  // Deterministic order — sort by path.
  routes.sort((a, b) => a.path.localeCompare(b.path));
  return routes;
}

/**
 * Parse CLAUDE.md (or any repo-root doc) into three signals:
 *   - sections: array of top-level H1/H2 headings (text after leading #)
 *   - urls: unique array of http(s) URLs mentioned in the body, sorted
 *   - hash: sha256 of the raw UTF-8 bytes (low-level change detector)
 *
 * Sections + URLs are high-signal for curated-knowledge drift: a URL
 * appearing or disappearing almost always means an endpoint moved.
 * Section change usually means the doc has been restructured and
 * someone should re-read for narrative drift.
 */
export function parseClaudeMdStructure(content) {
  if (!content) return { sections: [], urls: [], hash: null };
  const lines = content.split(/\r?\n/);
  const sections = [];
  for (const line of lines) {
    const m = line.match(/^(#{1,2})\s+(.+?)\s*$/);
    if (m) sections.push(m[2].trim());
  }
  const urlSet = new Set();
  // Grab bare URLs plus markdown-linked URLs. Strip trailing punctuation
  // that commonly tails a URL in prose.
  for (const m of content.matchAll(/https?:\/\/[^\s)\]<>"']+/g)) {
    let u = m[0].replace(/[.,;:!?)]+$/, '');
    urlSet.add(u);
  }
  const urls = [...urlSet].sort();
  const hash = createHash('sha256').update(content, 'utf8').digest('hex');
  return { sections, urls, hash };
}

/**
 * Walk a SvelteKit `frontend/src/routes/` tree and return the route
 * inventory as an array of POSIX-style paths matching the URL structure
 * (e.g. `/bots/guide`, `/bots/[id]/test`). Only directories that
 * contain a `+page.svelte`, `+page.ts`, `+page.server.ts`, or
 * `+layout.svelte` count as routes.
 */
export function walkSvelteKitRoutes(routesDir) {
  if (!existsSync(routesDir)) return null;
  const paths = new Set();
  const ROUTE_MARKERS = new Set([
    '+page.svelte', '+page.ts', '+page.server.ts', '+layout.svelte', '+server.ts',
  ]);
  const walk = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    let hasMarker = false;
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        const nextRel = rel === '' ? entry : `${rel}/${entry}`;
        walk(full, nextRel);
      } else if (ROUTE_MARKERS.has(entry)) {
        hasMarker = true;
      }
    }
    if (hasMarker) {
      // Normalise SvelteKit (group) segments — `(auth)` / `(app)` are
      // layout-only, do not appear in the URL. Strip them.
      const normalised = rel
        .split('/')
        .filter((s) => !(s.startsWith('(') && s.endsWith(')')))
        .join('/');
      paths.add(`/${normalised}`.replace(/\/+$/, '') || '/');
    }
  };
  walk(routesDir, '');
  return [...paths].sort();
}

/**
 * Fetch frontend routes from the bot-council GitHub repo when the
 * `frontend/src/routes/` directory isn't present locally (e.g. on EVO,
 * which has only the built bundle). Uses the public git-trees API —
 * no auth required for public repos. Returns null on any failure; the
 * caller records `frontend-source-unavailable` rather than erroring.
 *
 * @param {object} opts
 * @param {string} opts.owner — repo owner (jamescockburn47)
 * @param {string} opts.repo — repo name (bot-council)
 * @param {string} [opts.branch] — default 'main'
 * @param {typeof fetch} [opts.fetchFn] — injected for tests
 */
export async function fetchFrontendRoutesFromGithub({ owner, repo, branch = 'main', fetchFn = globalThis.fetch } = {}) {
  if (!owner || !repo) return null;
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  try {
    const res = await fetchFn(url, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'clawdbot-drift-detector' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.tree)) return null;
    const prefix = 'frontend/src/routes/';
    const ROUTE_MARKERS = /\/(?:\+page\.svelte|\+page\.ts|\+page\.server\.ts|\+layout\.svelte|\+server\.ts)$/;
    const paths = new Set();
    for (const entry of data.tree) {
      if (entry.type !== 'blob') continue;
      if (!entry.path?.startsWith(prefix)) continue;
      if (!ROUTE_MARKERS.test(entry.path)) continue;
      const relToRoutes = entry.path.slice(prefix.length);
      const segs = relToRoutes.split('/').slice(0, -1)  // drop filename
        .filter((s) => !(s.startsWith('(') && s.endsWith(')')));
      paths.add(`/${segs.join('/')}`.replace(/\/+$/, '') || '/');
    }
    return [...paths].sort();
  } catch {
    return null;
  }
}

/**
 * Extract the snapshot from a checkout directory. Missing files are
 * tolerated — the field is set to null / empty so the snapshot is
 * comparable across runs. Async because frontend-routes fallback may
 * hit GitHub when local source isn't available.
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {string} [opts.githubOwner]  — defaults to 'jamescockburn47'
 * @param {string} [opts.githubRepo]   — defaults to 'bot-council'
 * @param {string} [opts.githubBranch] — defaults to 'main'
 * @param {typeof fetch} [opts.fetchFn]
 */
export async function extractFactsFromCheckout(repoRoot, opts = {}) {
  if (!existsSync(repoRoot)) {
    return { sourceAvailable: false, repoRoot };
  }
  const safeRead = (relPath) => {
    const full = join(repoRoot, relPath);
    if (!existsSync(full)) return null;
    try {
      return readFileSync(full, 'utf8');
    } catch {
      return null;
    }
  };

  const typesContent = safeRead('src/types.rs');
  const errorKindContent = safeRead('src/orchestrator/error_kind.rs');
  const stateMachineContent = safeRead('src/orchestrator/state_machine.rs');
  const configContent = safeRead('config/default.toml');
  const apiModContent = safeRead('src/api/mod.rs');
  const claudeMdContent = safeRead('CLAUDE.md');

  const localRoutesDir = join(repoRoot, 'frontend', 'src', 'routes');
  let frontendRoutes = walkSvelteKitRoutes(localRoutesDir);
  let frontendRoutesSource = frontendRoutes ? 'local' : null;
  if (!frontendRoutes) {
    const fetched = await fetchFrontendRoutesFromGithub({
      owner: opts.githubOwner || 'jamescockburn47',
      repo: opts.githubRepo || 'bot-council',
      branch: opts.githubBranch || 'main',
      fetchFn: opts.fetchFn,
    });
    if (fetched) {
      frontendRoutes = fetched;
      frontendRoutesSource = 'github';
    }
  }

  return {
    sourceAvailable: true,
    repoRoot,
    roles: typesContent ? parseRolesFromTypes(typesContent) : [],
    errorKinds: errorKindContent ? parseErrorKinds(errorKindContent) : [],
    roundCount: stateMachineContent ? parseRoundCount(stateMachineContent) : null,
    roundTimeoutSeconds:
      (configContent && parseRoundTimeoutSeconds(configContent)) ||
      (errorKindContent && parseRoundTimeoutSeconds(errorKindContent)) ||
      null,
    apiRoutes: apiModContent ? parseApiRoutes(apiModContent) : [],
    claudeMd: claudeMdContent ? parseClaudeMdStructure(claudeMdContent) : { sections: [], urls: [], hash: null },
    frontendRoutes,
    frontendRoutesSource,
  };
}

/**
 * Diff two snapshots. Returns an array of change records. Empty array means
 * identical.
 */
export function diffSnapshots(oldSnap, newSnap) {
  const changes = [];
  if (!oldSnap || !oldSnap.sourceAvailable) {
    // First run — treat as initial snapshot, not drift.
    return [{ kind: 'initial-snapshot', newSnap }];
  }
  if (!newSnap || !newSnap.sourceAvailable) {
    changes.push({
      kind: 'source-unavailable',
      oldPath: oldSnap.repoRoot,
      newPath: newSnap?.repoRoot,
    });
    return changes;
  }

  const arrDiff = (field, a, b) => {
    const sa = [...(a || [])].sort();
    const sb = [...(b || [])].sort();
    if (JSON.stringify(sa) === JSON.stringify(sb)) return null;
    const added = sb.filter((x) => !sa.includes(x));
    const removed = sa.filter((x) => !sb.includes(x));
    return { field, added, removed, old: sa, new: sb };
  };

  for (const field of ['roles', 'errorKinds']) {
    const d = arrDiff(field, oldSnap[field], newSnap[field]);
    if (d) changes.push({ kind: 'array-diff', ...d });
  }
  for (const field of ['roundCount', 'roundTimeoutSeconds']) {
    if (oldSnap[field] !== newSnap[field]) {
      changes.push({
        kind: 'scalar-diff',
        field,
        old: oldSnap[field],
        new: newSnap[field],
      });
    }
  }

  // API route diff — path+methods granularity so a GET→POST swap or a
  // method additions to an existing route surfaces as drift.
  const oldRoutes = Array.isArray(oldSnap.apiRoutes) ? oldSnap.apiRoutes : [];
  const newRoutes = Array.isArray(newSnap.apiRoutes) ? newSnap.apiRoutes : [];
  const oldRouteMap = new Map(oldRoutes.map((r) => [r.path, r.methods.join(',')]));
  const newRouteMap = new Map(newRoutes.map((r) => [r.path, r.methods.join(',')]));
  const addedRoutes = [];
  const removedRoutes = [];
  const changedRoutes = [];
  for (const [path, methods] of newRouteMap) {
    if (!oldRouteMap.has(path)) addedRoutes.push(`${path} [${methods}]`);
    else if (oldRouteMap.get(path) !== methods) {
      changedRoutes.push(`${path} [${oldRouteMap.get(path)}]→[${methods}]`);
    }
  }
  for (const [path, methods] of oldRouteMap) {
    if (!newRouteMap.has(path)) removedRoutes.push(`${path} [${methods}]`);
  }
  if (addedRoutes.length || removedRoutes.length || changedRoutes.length) {
    changes.push({
      kind: 'api-routes-diff',
      field: 'apiRoutes',
      added: addedRoutes,
      removed: removedRoutes,
      changed: changedRoutes,
    });
  }

  // CLAUDE.md diff — three tiers. URL changes are the highest-signal
  // (curated-knowledge URL refs should be updated immediately);
  // section changes medium (narrative drift); hash-only changes low
  // (minor edits not worth paging on).
  const oldClaude = oldSnap.claudeMd || {};
  const newClaude = newSnap.claudeMd || {};
  const sectionsDiff = arrDiff('claudeMd.sections', oldClaude.sections, newClaude.sections);
  if (sectionsDiff) changes.push({ kind: 'array-diff', ...sectionsDiff });
  const urlsDiff = arrDiff('claudeMd.urls', oldClaude.urls, newClaude.urls);
  if (urlsDiff) changes.push({ kind: 'array-diff', ...urlsDiff });
  if (oldClaude.hash && newClaude.hash && oldClaude.hash !== newClaude.hash
      && !sectionsDiff && !urlsDiff) {
    changes.push({
      kind: 'claude-md-hash-only',
      field: 'claudeMd.hash',
      old: oldClaude.hash.slice(0, 12),
      new: newClaude.hash.slice(0, 12),
    });
  }

  // Frontend route diff. `null` on either side means "source
  // unavailable" — we record that separately rather than as drift so a
  // transient GitHub rate-limit doesn't produce a noisy proposal.
  if (oldSnap.frontendRoutes !== null && newSnap.frontendRoutes !== null) {
    const feDiff = arrDiff('frontendRoutes', oldSnap.frontendRoutes, newSnap.frontendRoutes);
    if (feDiff) changes.push({ kind: 'array-diff', ...feDiff });
  } else if (oldSnap.frontendRoutes === null && newSnap.frontendRoutes !== null) {
    // First time we got frontend data — informational, not drift.
    changes.push({
      kind: 'frontend-routes-first-snapshot',
      field: 'frontendRoutes',
      count: newSnap.frontendRoutes.length,
      source: newSnap.frontendRoutesSource || 'unknown',
    });
  } else if (oldSnap.frontendRoutes !== null && newSnap.frontendRoutes === null) {
    // Was available, now missing — usually transient. Flag as non-
    // actionable so the morning report surfaces it but we don't rewrite
    // knowledge on a 404.
    changes.push({
      kind: 'frontend-source-unavailable',
      field: 'frontendRoutes',
      previousCount: oldSnap.frontendRoutes.length,
    });
  }

  return changes;
}
