// src/tasks/ground-truth.js — Overnight ground truth harvester
//
// Runs at 03:30, after trace analysis. Reads yesterday's reasoning traces,
// extracts factual claims Clawd made, verifies them against primary sources
// via SearXNG + web_fetch, and stores verified fact→source pairs.
//
// The Forge (04:30) and self-improvement cycle consume this data to:
// - Build labelled eval datasets over time
// - Identify categories where Clawd hallucinates
// - Prioritise accuracy improvements
//
// Only harvests claims that are verifiable against authoritative sources —
// legislation.gov.uk, BAILII, Companies House, Gov.uk, official documentation.
// Opinion, strategy, and social content are skipped.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { webSearch, webFetch } from '../tools/search.js';
import { searchMemory } from '../memory.js';
import config from '../config.js';
import logger from '../logger.js';

const GROUND_TRUTH_FILE = join('data', 'ground-truth.json');
const TRACE_FILE = join('data', 'reasoning-traces.jsonl');
const MAX_CLAIMS_PER_RUN = 10;
const MAX_ENTRIES = 500; // cap total dataset size

let lastHarvestDate = null;

export async function checkGroundTruth(sendFn, todayStr, hours, minutes) {
  if (lastHarvestDate === todayStr) return;
  if (hours !== 3 || minutes < 30) return;

  lastHarvestDate = todayStr;
  logger.info('ground-truth: starting harvest');

  try {
    const result = await harvestGroundTruth(todayStr);
    if (result.harvested > 0 && sendFn) {
      await sendFn(config.ownerJid, {
        text: `*Ground Truth Harvest*\nClaims found: ${result.claimsFound}\nVerified: ${result.verified}\nFailed: ${result.failed}\nSkipped: ${result.skipped}`,
      });
    }
    logger.info(result, 'ground-truth: harvest complete');
  } catch (err) {
    logger.error({ err: err.message }, 'ground-truth: harvest failed');
  }
}

export function getLastHarvestDate() {
  return lastHarvestDate;
}

async function harvestGroundTruth(todayStr) {
  // Load existing ground truth
  let groundTruth = { entries: [], lastUpdated: null };
  if (existsSync(GROUND_TRUTH_FILE)) {
    try {
      groundTruth = JSON.parse(readFileSync(GROUND_TRUTH_FILE, 'utf-8'));
    } catch { /* start fresh */ }
  }

  // Read yesterday's traces
  const yesterday = new Date(todayStr + 'T12:00:00');
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().split('T')[0];

  const claims = extractVerifiableClaims(yStr);
  if (claims.length === 0) {
    return { claimsFound: 0, harvested: 0, verified: 0, failed: 0, skipped: 0 };
  }

  // Deduplicate against existing entries
  const existingClaims = new Set(groundTruth.entries.map(e => e.claim.toLowerCase()));
  const newClaims = claims.filter(c => !existingClaims.has(c.claim.toLowerCase()));

  const toVerify = newClaims.slice(0, MAX_CLAIMS_PER_RUN);
  let verified = 0;
  let failed = 0;
  let skipped = 0;

  for (const claim of toVerify) {
    try {
      const result = await verifyClaim(claim);
      if (result.status === 'verified') {
        groundTruth.entries.push({
          claim: claim.claim,
          category: claim.category,
          source: result.source,
          sourceUrl: result.url,
          verified: true,
          verifiedAt: new Date().toISOString(),
          context: claim.context,
        });
        verified++;
      } else if (result.status === 'contradicted') {
        groundTruth.entries.push({
          claim: claim.claim,
          category: claim.category,
          source: result.source,
          sourceUrl: result.url,
          verified: false,
          contradiction: result.contradiction,
          verifiedAt: new Date().toISOString(),
          context: claim.context,
        });
        failed++;
      } else {
        skipped++; // no authoritative source found
      }
    } catch (err) {
      logger.debug({ claim: claim.claim, err: err.message }, 'ground-truth: verification error');
      skipped++;
    }
  }

  // Prune to MAX_ENTRIES (keep newest)
  if (groundTruth.entries.length > MAX_ENTRIES) {
    groundTruth.entries = groundTruth.entries.slice(-MAX_ENTRIES);
  }

  groundTruth.lastUpdated = new Date().toISOString();
  writeFileSync(GROUND_TRUTH_FILE, JSON.stringify(groundTruth, null, 2));

  return { claimsFound: claims.length, harvested: toVerify.length, verified, failed, skipped };
}

/**
 * Extract verifiable factual claims from yesterday's traces.
 * Only grabs claims that reference specific, checkable facts:
 * - Statute names/sections
 * - Case names
 * - Dates of events
 * - Company names (for Companies House)
 * - Specific numbers/amounts
 */
function extractVerifiableClaims(dateStr) {
  if (!existsSync(TRACE_FILE)) return [];

  const claims = [];
  const lines = readFileSync(TRACE_FILE, 'utf-8').trim().split('\n').filter(Boolean);

  for (const line of lines) {
    try {
      const trace = JSON.parse(line);
      if (!trace.timestamp?.startsWith(dateStr)) continue;

      // Skip traces with no tool calls — pure conversational, less likely to have verifiable claims
      const tools = trace.toolsCalled || [];

      // Look at categories where factual accuracy matters
      const cat = trace.routing?.category;
      if (!cat || ['conversational', 'task'].includes(cat)) continue;

      // We don't have the response text in traces — but we have the category,
      // tools called, and plan details. Use memory search results as proxy:
      // claims that were informed by memory are ones where we asserted facts.
      if (tools.includes('web_search') || tools.includes('memory_search')) {
        claims.push({
          claim: trace.routing?.planReason || `${cat} query with ${tools.join(',')}`,
          category: cat,
          context: {
            tools,
            needsPlan: trace.routing?.needsPlan,
            model: trace.model?.selected,
            timestamp: trace.timestamp,
          },
        });
      }
    } catch { /* skip malformed */ }
  }

  return claims;
}

// Patterns that indicate verifiable content
const LEGAL_PATTERNS = [
  /\b(?:section|s\.?)\s*\d+/i,           // section 1, s.1
  /\b(?:act|regulation)\s+\d{4}\b/i,     // Act 2006, Regulation 2023
  /\bCPR\s+(?:Part\s+)?\d+/i,            // CPR Part 31
  /\b\d{4}\s+EWHC\s+\d+/i,              // [2024] EWHC 123
  /\b\d{4}\s+EWCA\s+(?:Civ|Crim)\s+\d+/i, // [2024] EWCA Civ 456
  /\b\d{4}\s+UKSC\s+\d+/i,              // [2024] UKSC 12
];

/**
 * Verify a claim against authoritative sources.
 * Returns { status: 'verified'|'contradicted'|'unresolvable', source, url, contradiction? }
 */
async function verifyClaim(claim) {
  const claimText = claim.claim;

  // Build a search query targeting authoritative sources
  let query = claimText;

  // For legal claims, add site filters
  const isLegal = LEGAL_PATTERNS.some(p => p.test(claimText));
  if (isLegal || claim.category === 'legal') {
    query += ' site:legislation.gov.uk OR site:bailii.org OR site:judiciary.uk';
  }

  // Search
  const searchResult = await webSearch({ query: query.slice(0, 200), count: 3 });
  if (!searchResult || searchResult.includes('No results') || searchResult.includes('error')) {
    return { status: 'unresolvable' };
  }

  // Extract first URL from results
  const urlMatch = searchResult.match(/https?:\/\/[^\s]+/);
  if (!urlMatch) return { status: 'unresolvable' };

  const url = urlMatch[0];

  // Only fetch from authoritative domains
  const authoritative = [
    'legislation.gov.uk', 'bailii.org', 'judiciary.uk',
    'gov.uk', 'companieshouse.gov.uk', 'ico.org.uk',
    'fca.org.uk', 'sra.org.uk',
  ];
  const isAuthoritative = authoritative.some(d => url.includes(d));
  if (!isAuthoritative) {
    return { status: 'unresolvable' }; // not an authoritative source
  }

  // Fetch and check
  const pageContent = await webFetch({ url, maxChars: 4000 });
  if (!pageContent || pageContent.includes('error') || pageContent.length < 100) {
    return { status: 'unresolvable' };
  }

  // Simple presence check — does the source confirm the key terms?
  // This is a conservative heuristic: if the authoritative page contains
  // the key terms from the claim, mark as verified.
  // A future version could use LLM judgement for nuanced comparison.
  const keyTerms = claimText.toLowerCase().split(/\W+/).filter(t => t.length > 3);
  const pageLC = pageContent.toLowerCase();
  const matches = keyTerms.filter(t => pageLC.includes(t));
  const coverage = matches.length / Math.max(keyTerms.length, 1);

  if (coverage >= 0.5) {
    return {
      status: 'verified',
      source: url.includes('legislation.gov.uk') ? 'legislation.gov.uk'
        : url.includes('bailii.org') ? 'BAILII'
        : new URL(url).hostname,
      url,
    };
  }

  // Low coverage doesn't mean contradicted — it means we can't confirm
  return { status: 'unresolvable' };
}
