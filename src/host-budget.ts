/**
 * Per-host politeness.
 *
 * The catalogue points 17,600 streams at 6,035 hosts, and a handful of CDNs carry
 * hundreds of channels each. Probing is a courtesy to hosts the project does not
 * pay for, so this module enforces the three rules that matter: one request at a
 * time per host, a minimum gap between requests, and an immediate stop for a host
 * that answers `429`.
 *
 * A tripped host is skipped rather than retried. A host that has rate-limited us
 * three times in one sweep is the clearest possible signal to leave it alone until
 * the next sweep, and skipping records no evidence — the stream stays unproven,
 * which the app treats as visible.
 */

const DEFAULT_MIN_SPACING_MS = 500;
const DEFAULT_TRIP_AFTER = 3;

/**
 * Longest `Retry-After` this module will act on.
 *
 * A sweep is minutes long, so a host told to come back in a day is skipped for
 * this sweep either way; the cap only exists so a malformed or hostile header
 * cannot set a cooldown that outlasts every possible run.
 */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

export class HostBudget {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly lastRequestAt = new Map<string, number>();
  private readonly strikes = new Map<string, number>();
  private readonly tripped = new Set<string>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly minSpacingMs: number;
  private readonly tripAfter: number;
  private readonly now: () => number;

  constructor(options?: { minSpacingMs?: number; tripAfter?: number; now?: () => number }) {
    this.minSpacingMs = options?.minSpacingMs ?? DEFAULT_MIN_SPACING_MS;
    this.tripAfter = options?.tripAfter ?? DEFAULT_TRIP_AFTER;
    this.now = options?.now ?? Date.now;
  }

  /** Whether a host is currently off limits, either by strikes or by a cooldown. */
  isTripped(host: string): boolean {
    if (this.tripped.has(host)) {
      return true;
    }
    const until = this.cooldownUntil.get(host);
    return until !== undefined && this.now() < until;
  }

  /**
   * Records a `429`, honouring `Retry-After` when the server sends one.
   *
   * A server that states a cooldown has said more than a bare 429, so it is taken
   * at its word: the host is skipped until the window it named, without waiting
   * for `tripAfter` strikes. The usual reason a host is left alone is that it asked
   * to be, and a sweep that ignored the one instruction the server actually gave
   * would be the worse neighbour.
   *
   * A cooldown is deliberately *not* a strike and does not become one. The two mean
   * different things: a strike is a judgement that this host is a bad neighbour for
   * the rest of the sweep, while `Retry-After` is a timestamp that simply expires.
   * Folding one into the other would make a two-second cooldown as sticky as three
   * 429s and leave the value the server sent us doing no work at all.
   *
   * A bare 429 carries no such instruction, so it falls back to the strike counter.
   * A single 429 is usually a burst from a shared CDN edge rather than a real limit,
   * and dropping a host carrying hundreds of channels on one would cost a lot of
   * evidence for very little.
   *
   * Skipping records no evidence, so a rate-limited channel stays unproven and the
   * app keeps showing it.
   */
  noteRateLimit(host: string, retryAfterSeconds?: number): void {
    const cooldownMs = parseRetryAfter(retryAfterSeconds);
    if (cooldownMs !== null) {
      this.cooldownUntil.set(host, this.now() + cooldownMs);
      return;
    }
    const count = (this.strikes.get(host) ?? 0) + 1;
    this.strikes.set(host, count);
    if (count >= this.tripAfter) {
      this.tripped.add(host);
    }
  }

  /**
   * Runs `work` in this host's turn, waiting for the spacing window first.
   *
   * Work is serialised per host by chaining onto a per-host promise, so
   * concurrency stays high across the catalogue while collapsing to one request
   * in flight for any single origin.
   */
  async run<T>(host: string, work: () => Promise<T>, now: () => number = this.now): Promise<T> {
    const prior = this.chains.get(host) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.chains.set(
      host,
      prior.then(
        () => gate,
        () => gate,
      ),
    );

    await prior.catch(() => undefined);
    try {
      const last = this.lastRequestAt.get(host);
      if (last !== undefined) {
        const wait = this.minSpacingMs - (now() - last);
        if (wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
      this.lastRequestAt.set(host, now());
      return await work();
    } finally {
      release();
    }
  }
}

/**
 * Reads a `Retry-After` delay in seconds, or `null` when there is not a usable one.
 *
 * Only the delta-seconds form is honoured. The HTTP-date form is legal but a
 * server sending it is vanishingly rare next to the numeric form, and a clock
 * disagreement is exactly the kind of thing that would silently extend a
 * cooldown forever. Anything unparseable, negative or absurd falls back to the
 * strike counter, which is the conservative reading.
 */
export function parseRetryAfter(value: number | string | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  if (value <= 0) {
    return null;
  }
  return Math.min(value * 1000, MAX_RETRY_AFTER_MS);
}

/** Groups hosts in a stable order, so a rerun of a shard requests hosts identically. */
export function groupByHost<T extends { url: string }>(items: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    let host: string;
    try {
      host = new URL(item.url).host;
    } catch {
      continue;
    }
    const existing = groups.get(host);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(host, [item]);
    }
  }
  return groups;
}
