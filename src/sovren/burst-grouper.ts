/// <reference types="node" />
import type { BurstMessage } from './types.js';

/**
 * Per-contributor in-memory burst grouper.
 *
 * A "burst" is a sequence of messages from the same contributor in a SOVREN
 * context, separated by no more than `BURST_GAP_MS` of silence. Bursts are
 * how today's pattern from Peter looks: cover email, attachment, "And finally:",
 * template — four messages in two minutes that conceptually form one
 * contribution.
 *
 * The grouper holds open bursts in memory keyed by `<contributorSlug>:<chatJid>`.
 * Each call to `record` either appends to an open burst or, if the gap has
 * elapsed, closes the previous burst and starts a new one.
 *
 * `closeIdle()` is meant to be called from a timer (or from the next message
 * arrival) to flush bursts that have gone quiet. The flushed burst is passed
 * to the supplied callback, which is responsible for downstream processing
 * (writing to the contribution store, kicking off methodology extraction, etc.).
 *
 * The grouper does not persist state across restarts. Bursts that don't close
 * before a restart are lost from the in-memory grouper but the underlying
 * messages remain in conversation logs and can be reconstructed retroactively.
 */

const BURST_GAP_MS = 5 * 60 * 1000; // 5 minutes — matches the follow-up window default

interface OpenBurst {
  contributorSlug: string;
  chatJid: string;
  messages: BurstMessage[];
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface BurstFlushHandler {
  (burst: ClosedBurst): void | Promise<void>;
}

export interface ClosedBurst {
  contributorSlug: string;
  chatJid: string;
  messages: BurstMessage[];
  firstSeenAt: string;
  lastSeenAt: string;
  durationMs: number;
}

export class BurstGrouper {
  private readonly bursts = new Map<string, OpenBurst>();
  private readonly flushHandler: BurstFlushHandler;
  private readonly gapMs: number;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(flushHandler: BurstFlushHandler, gapMs: number = BURST_GAP_MS) {
    this.flushHandler = flushHandler;
    this.gapMs = gapMs;
  }

  /** Key for the bursts map. */
  private keyOf(contributorSlug: string, chatJid: string): string {
    return `${contributorSlug}:${chatJid}`;
  }

  /**
   * Append a message to the contributor's open burst, or start a new one.
   * If a previous burst was open and has now exceeded the gap, it is closed
   * and flushed before the new message is recorded.
   */
  record(input: {
    contributorSlug: string;
    chatJid: string;
    timestamp: number;
    senderName: string;
    text: string;
    attachment: { fileName: string; mimetype: string; captured: boolean } | null;
  }): void {
    const key = this.keyOf(input.contributorSlug, input.chatJid);
    const open = this.bursts.get(key);

    if (open && input.timestamp - open.lastSeenAt > this.gapMs) {
      this.flushBurst(key, open);
    }

    let burst = this.bursts.get(key);
    if (!burst) {
      burst = {
        contributorSlug: input.contributorSlug,
        chatJid: input.chatJid,
        messages: [],
        firstSeenAt: input.timestamp,
        lastSeenAt: input.timestamp,
      };
      this.bursts.set(key, burst);
    }

    burst.messages.push({
      timestamp: new Date(input.timestamp).toISOString(),
      senderName: input.senderName,
      text: input.text,
      attachment: input.attachment,
    });
    burst.lastSeenAt = input.timestamp;

    this.scheduleFlushTimer();
  }

  /** Flush every burst that has been quiet for longer than `gapMs`. */
  closeIdle(now: number = Date.now()): void {
    for (const [key, burst] of this.bursts.entries()) {
      if (now - burst.lastSeenAt > this.gapMs) {
        this.flushBurst(key, burst);
      }
    }
  }

  /** Force-close every open burst regardless of timing (used at shutdown / tests). */
  flushAll(): void {
    for (const [key, burst] of this.bursts.entries()) {
      this.flushBurst(key, burst);
    }
  }

  private flushBurst(key: string, burst: OpenBurst): void {
    this.bursts.delete(key);
    const closed: ClosedBurst = {
      contributorSlug: burst.contributorSlug,
      chatJid: burst.chatJid,
      messages: burst.messages,
      firstSeenAt: new Date(burst.firstSeenAt).toISOString(),
      lastSeenAt: new Date(burst.lastSeenAt).toISOString(),
      durationMs: burst.lastSeenAt - burst.firstSeenAt,
    };
    // Fire-and-forget; flush handler errors are the handler's responsibility.
    Promise.resolve(this.flushHandler(closed)).catch(() => {
      // intentional: flush failures must not break the grouper itself.
    });
  }

  /**
   * Ensure there is a single timer that will eventually call `closeIdle`. The
   * timer interval matches the gap so the worst-case flush latency is 2x gap.
   */
  private scheduleFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.closeIdle();
      if (this.bursts.size === 0 && this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
      }
    }, this.gapMs);
    // Don't keep the event loop alive just for the grouper.
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  /** Test helper: drop all open bursts without flushing. */
  clearForTest(): void {
    this.bursts.clear();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Test helper: peek at currently open bursts. */
  openBurstCount(): number {
    return this.bursts.size;
  }
}
