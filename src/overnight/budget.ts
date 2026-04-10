// src/overnight/budget.ts — Opus session budget tracker for the overnight runner.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §5.5.
//
// A stage that wants to invoke Opus must call requestSession() first. Over-budget
// calls are refused (allowed:false) so the stage can record a skipped event.
// Counter resets at 22:00 London (the start of the overnight window).

export type BudgetNightMode = 'cheap' | 'deep' | 'emergency';

const MODE_CAPS: Readonly<Record<BudgetNightMode, number>> = Object.freeze({
  cheap: 1,
  deep: 2,
  emergency: 3,
});

export interface BudgetTrackerOptions {
  mode: BudgetNightMode;
  /** Override for tests. Defaults to Date.now-based. */
  now?: () => Date;
}

export interface SessionRequest {
  stage: string;
  purpose: string;
}

export interface SessionDecision {
  allowed: boolean;
  reason?: string;
}

export class BudgetTracker {
  private readonly mode: BudgetNightMode;
  private readonly nowFn: () => Date;
  private count = 0;
  private lastResetEpoch: number;

  constructor(opts: BudgetTrackerOptions) {
    this.mode = opts.mode;
    this.nowFn = opts.now ?? (() => new Date());
    this.lastResetEpoch = this.nightEpochFor(this.nowFn());
  }

  get sessionCap(): number {
    return MODE_CAPS[this.mode];
  }

  get sessionsUsed(): number {
    return this.count;
  }

  /**
   * Check whether the 22:00 London reset boundary has been crossed since the
   * last observation, and if so, zero the counter. Called automatically by
   * requestSession(); exposed for tests and for pre-stage introspection.
   */
  maybeReset(): void {
    const currentEpoch = this.nightEpochFor(this.nowFn());
    if (currentEpoch !== this.lastResetEpoch) {
      this.count = 0;
      this.lastResetEpoch = currentEpoch;
    }
  }

  requestSession(req: SessionRequest): SessionDecision {
    this.maybeReset();
    if (this.count >= this.sessionCap) {
      return {
        allowed: false,
        reason: `budget exceeded: ${this.mode} mode allows ${this.sessionCap} session(s), already used ${this.count} (request: ${req.stage}/${req.purpose})`,
      };
    }
    this.count += 1;
    return { allowed: true };
  }

  /**
   * Return an integer identifier for the "overnight window" that `at` falls in.
   * The window begins at 22:00 London local time. Dates before 22:00 London
   * belong to the previous day's window.
   */
  private nightEpochFor(at: Date): number {
    // Use Intl.DateTimeFormat to extract London-local parts explicitly. Avoids
    // the toLocaleString round-trip which is locale-sensitive.
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);

    const get = (type: Intl.DateTimeFormatPartTypes): number => {
      const part = parts.find((p) => p.type === type);
      if (!part) throw new Error(`missing ${type} in formatToParts output`);
      return parseInt(part.value, 10);
    };

    const year = get('year');
    const month = get('month');
    const day = get('day');
    const hour = get('hour');

    // "Night N" covers London [day N 22:00 → day N+1 22:00).
    // If the current London hour is <22, we're still in day N-1's window.
    // Represent the window as days-since-epoch for the window's start day.
    const msPerDay = 86_400_000;
    const londonDateStart = Date.UTC(year, month - 1, day); // midnight that London-day
    let windowStartDay = Math.floor(londonDateStart / msPerDay);
    if (hour < 22) windowStartDay -= 1;
    return windowStartDay;
  }
}
