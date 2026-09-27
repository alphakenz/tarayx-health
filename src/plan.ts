import { groupByHost } from './host-budget.ts';
import { hashUnit, sha1Key, shardOf } from './hash.ts';
import type { StateFile, StreamRow, StreamState } from './types.ts';

/**
 * Decides which streams this shard sweeps.
 *
 * Re-probing all 17,600 streams every two hours would be rude and slow, and it
 * would buy very little: a stream that reported `up` ten minutes ago is not going
 * to be back before the next sweep. The schedule is tiered by what we currently
 * believe, and the healthy tier is sampled rather than polled:
 *
 * - never probed      → always probe
 * - previously `down` → probe every sweep; this is what advances and clears the
 *                       streak that decides whether a channel may be hidden
 * - previously `up`   → probe again only once it is stale (6 h) *and* it lands in
 *                       a deterministic 20% sample
 * - previously `blocked` → same sampling as `up`, since a 403 or a timeout is not
 *                       evidence and mostly is not going to change between sweeps
 * - previously `skipped` → always probe, since being skipped produced no evidence
 *
 * The sample is derived from a hash of the URL rather than a random draw, so a
 * rerun of a shard makes the same choice and shards never disagree about who owns
 * a stream.
 */

export type PlanOptions = {
  now: number;
  shard: number;
  shardCount: number;
  /** How long an `up` result is considered fresh enough not to re-probe. */
  upFreshMs: number;
  /** Percentage of stale-but-healthy streams to re-probe. */
  upSamplePercent: number;
  /** Minimum gap between two probes of a stream last seen `down`. */
  downRevisitMs: number;
  /** Hard ceiling on requests for the shard, so a bad sweep cannot overrun a run. */
  maxProbes: number;
  /** Ceiling per host, protecting the largest CDNs. */
  maxPerHost: number;
};

export type PlanResult = {
  /** Probes to run, grouped by host, hosts in stable order. */
  byHost: Map<string, StreamRow[]>;
  selected: StreamRow[];
  stats: {
    total: number;
    fresh: number;
    sampled: number;
    neverSeen: number;
    revisitDown: number;
    shardExcluded: number;
    capped: number;
  };
};

const NEVER = -1;

function lastProbedAt(state: StreamState | undefined): number {
  return state?.a ?? NEVER;
}

/** Streams that must be probed now, ignoring per-host caps. */
function candidates(streams: readonly StreamRow[], state: StateFile, options: PlanOptions): {
  picks: StreamRow[];
  stats: PlanResult['stats'];
} {
  const stats = {
    total: streams.length,
    fresh: 0,
    sampled: 0,
    neverSeen: 0,
    revisitDown: 0,
    shardExcluded: 0,
    capped: 0,
  };
  const picks: Array<{ row: StreamRow; priority: number }> = [];

  for (const row of streams) {
    let host: string;
    try {
      host = new URL(row.url).host;
    } catch {
      continue;
    }
    if (shardOf(host, options.shardCount) !== options.shard) {
      stats.shardExcluded += 1;
      continue;
    }

    const key = sha1Key(row.url);
    const previous = state.streams[key];

    if (previous === undefined || previous.s === 'x') {
      stats.neverSeen += 1;
      picks.push({ row, priority: 0 });
      continue;
    }

    const age = options.now - lastProbedAt(previous);

    if (previous.s === 'd') {
      if (age < options.downRevisitMs) {
        stats.fresh += 1;
        continue;
      }
      stats.revisitDown += 1;
      picks.push({ row, priority: 1 });
      continue;
    }

    // `u` and `b` are both "no evidence of death": fresh results wait, stale ones
    // rejoin the sample.
    if (age < options.upFreshMs) {
      stats.fresh += 1;
      continue;
    }
    if (hashUnit(key) * 100 >= options.upSamplePercent) {
      stats.fresh += 1;
      continue;
    }
    stats.sampled += 1;
    picks.push({ row, priority: 2 });
  }

  // Unknown streams and down streaks are worth a request before a routine
  // resample; ties break on URL so the order is reproducible.
  picks.sort((a, b) => a.priority - b.priority || a.row.url.localeCompare(b.row.url));
  return { picks: picks.map((pick) => pick.row), stats };
}

export function planProbes(
  streams: readonly StreamRow[],
  state: StateFile,
  options: PlanOptions,
): PlanResult {
  const { picks, stats } = candidates(streams, state, options);
  const byHost = groupByHost(picks);
  const selected: StreamRow[] = [];

  // `byHost`'s insertion order is the order hosts were first reached, and `picks`
  // was already priority-sorted, so iterating the map without re-sorting preserves
  // priority across the whole plan. That is what makes the `maxProbes` truncation
  // below drop the least valuable probes rather than an arbitrary alphabetical
  // slice of hosts.
  for (const host of byHost.keys()) {
    const rows = byHost.get(host) ?? [];
    const kept = rows.slice(0, options.maxPerHost);
    if (kept.length < rows.length) {
      stats.capped += rows.length - kept.length;
    }
    for (const row of kept) {
      selected.push(row);
    }
    if (selected.length >= options.maxProbes) {
      break;
    }
  }

  if (selected.length > options.maxProbes) {
    stats.capped += selected.length - options.maxProbes;
    selected.length = options.maxProbes;
  }

  byHost.clear();
  for (const row of selected) {
    const host = new URL(row.url).host;
    const existing = byHost.get(host);
    if (existing) {
      existing.push(row);
    } else {
      byHost.set(host, [row]);
    }
  }

  return { byHost, selected, stats };
}
