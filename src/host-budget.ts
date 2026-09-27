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

export class HostBudget {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly lastRequestAt = new Map<string, number>();
  private readonly strikes = new Map<string, number>();
  private readonly tripped = new Set<string>();
  private readonly minSpacingMs: number;
  private readonly tripAfter: number;

  constructor(options?: { minSpacingMs?: number; tripAfter?: number; now?: () => number }) {
    this.minSpacingMs = options?.minSpacingMs ?? DEFAULT_MIN_SPACING_MS;
    this.tripAfter = options?.tripAfter ?? DEFAULT_TRIP_AFTER;
  }

  /** Whether a host is currently off limits. */
  isTripped(host: string): boolean {
    return this.tripped.has(host);
  }

  /** Records a `429`. After `tripAfter` of them the host is dropped for the sweep. */
  noteRateLimit(host: string): void {
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
  async run<T>(host: string, work: () => Promise<T>, now: () => number = Date.now): Promise<T> {
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
