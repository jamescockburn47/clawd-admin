/// <reference types="node" />
import type { ContributorIdentity } from './types.js';

/**
 * Registry of known SOVREN contributors. Used by `contribution-detector` to
 * decide whether an incoming WhatsApp message should be treated as a
 * methodology contribution candidate.
 *
 * Adding a new contributor only requires appending to `CONTRIBUTORS`. There is
 * no per-contributor permissions layer here — group security and project
 * scoping in `group-registry.js` remain authoritative.
 *
 * The registry is a flat list because there are very few SOVREN contributors
 * (today: Peter, James). If it grows past ~10 entries, replace with a JSON
 * file in `data/runtime/sovren-contributors.json` and load on startup.
 */

const CONTRIBUTORS: ContributorIdentity[] = [
  {
    slug: 'peter',
    displayName: 'Peter',
    // Peter's WhatsApp LID is unknown until he sends; matched by display name
    // as a fallback. JID is filled in opportunistically as messages arrive.
    jids: [],
  },
  {
    slug: 'james',
    displayName: 'James C',
    // James is owner — his JIDs are tracked in config.ownerJid / ownerLid.
    // Listed here so forwards from James count as contributions.
    jids: [],
  },
];

/** Returns all known contributors. */
export function getContributors(): readonly ContributorIdentity[] {
  return CONTRIBUTORS;
}

/**
 * Find a contributor by JID or by display name (case-insensitive).
 * Returns null if no match.
 */
export function findContributor(
  senderJid: string | null,
  senderName: string | null,
): ContributorIdentity | null {
  const normalisedName = (senderName ?? '').trim().toLowerCase();
  for (const c of CONTRIBUTORS) {
    if (senderJid && c.jids.includes(senderJid)) return c;
    if (
      normalisedName &&
      c.displayName.trim().toLowerCase() === normalisedName
    ) {
      return c;
    }
  }
  return null;
}

/**
 * Opportunistically learn a contributor's JID the first time we see them by
 * name. In-memory only — survives the process lifetime, not restarts. The
 * persistent source of truth remains the literal `CONTRIBUTORS` list above.
 * Restarts re-learn on the next message from each contributor.
 */
export function learnContributorJid(
  senderJid: string | null,
  senderName: string | null,
): void {
  if (!senderJid || !senderName) return;
  const c = findContributor(null, senderName);
  if (c && !c.jids.includes(senderJid)) {
    c.jids.push(senderJid);
  }
}
