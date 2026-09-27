import { sha1Key } from './hash.ts';
import { HostBudget } from './host-budget.ts';
import { loadState, outDir, settings, writeJson } from './io.ts';
import { planProbes } from './plan.ts';
import { probeStream } from './probe.ts';
import type { Outcome, ProbeDeps } from './probe.ts';
import { fetchCatalog } from './streams.ts';
import type { ProbeRecord, ProbeState, StreamRow } from './types.ts';

/**
 * One shard of the sweep.
 *
 * Runs the plan for this shard, probes every selected stream under the host
 * politeness rules, and writes only its own records file. Shards never touch
 * shared state, so they run fully in parallel; the merge job is the single place
 * that folds results together and publishes.
 */

/**
 * Requests the way the catalogue says to.
 *
 * 789 rows declare a user agent and 324 a referrer, usually because the origin
 * rejects anything else. Ignoring them turns a working stream into a 403 and, on a
 * two-sweep rule, eventually into a hidden channel.
 */
function headersFor(row: StreamRow, userAgent: string): Record<string, string> {
  const headers: Record<string, string> = { 'user-agent': row.user_agent ?? userAgent };
  if (row.referrer !== null) {
    headers.referer = row.referrer;
  }
  return headers;
}

type Tally = Record<ProbeState, number>;

/**
 * A sweep is several thousand probes accumulated over minutes of wall time, and
 * records are only written at the end. Node's default is to treat an unhandled
 * rejection as fatal, which means one stray rejection discards every probe the
 * shard has already completed. The first real sweep lost three of four shards
 * exactly this way, to a body that aborted mid-read.
 *
 * This logs loudly and keeps going rather than exiting. It is not a way to hide a
 * defect: a probe that throws is recorded as `internal` (see below), which hides
 * nothing and never advances a down streak, so a broken build shows up in the
 * published feed instead of quietly looking healthy.
 */
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`unhandled rejection, continuing: ${String(reason)}\n`);
});

async function main(): Promise<void> {
  const budget = new HostBudget({ minSpacingMs: settings.minSpacingMs });
  const state = await loadState();
  const catalog = await fetchCatalog();

  const plan = planProbes(catalog, state, {
    now: Date.now(),
    shard: settings.shard,
    shardCount: settings.shardCount,
    upFreshMs: settings.upFreshMs,
    upSamplePercent: settings.upSamplePercent,
    downRevisitMs: settings.downRevisitMs,
    maxProbes: settings.maxProbes,
    maxPerHost: settings.maxPerHost,
  });

  process.stderr.write(
    `shard ${settings.shard}/${settings.shardCount}: ${plan.selected.length} probes of ` +
      `${plan.stats.total} streams (new ${plan.stats.neverSeen}, down ${plan.stats.revisitDown}, ` +
      `sampled ${plan.stats.sampled}, fresh ${plan.stats.fresh}, ` +
      `other shards ${plan.stats.shardExcluded}, capped ${plan.stats.capped})\n`,
  );

  const hosts = [...plan.byHost.keys()];
  const records: ProbeRecord[] = [];
  const tally: Tally = { up: 0, down: 0, blocked: 0, skipped: 0 };

  const deps: ProbeDeps = {
    fetchImpl: fetch,
    now: () => Date.now(),
    requestTimeoutMs: settings.requestTimeoutMs,
    segmentCapBytes: settings.segmentCapBytes,
    maxVariants: settings.maxVariants,
    maxSegmentAttempts: settings.maxSegmentAttempts,
    userAgent: settings.userAgent,
  };

  let cursor = 0;
  /**
   * Consumes hosts from a shared cursor, so work is claimed rather than sliced.
   * Hosts are pre-sorted, which keeps the request pattern reproducible for a
   * rerun even though completion order is not.
   */
  async function worker(): Promise<void> {
    for (;;) {
      const host = hosts[cursor];
      cursor += 1;
      if (host === undefined) {
        return;
      }
      for (const row of plan.byHost.get(host) ?? []) {
        const key = sha1Key(row.url);
        if (budget.isTripped(host)) {
          // The host asked us to stop. A skipped record carries no evidence, and
          // `reduceState` deliberately leaves the previous verdict untouched for
          // it, so a tripped host cannot decay a channel's verdict.
          records.push({ k: key, state: 'skipped', reason: 'host_skipped', ms: null, at: Date.now() });
          tally.skipped += 1;
          continue;
        }
        // A sweep is measured in hours of accumulated evidence, so a single stream
        // throwing must never discard the probes already recorded. Anything that
        // escapes the ladder is a defect in the prober rather than a fact about
        // the stream, and the safe way to record a defect is `blocked`: it hides
        // nothing, and it is not a down streak.
        let outcome: Outcome;
        try {
          outcome = await budget.run(host, () =>
            probeStream(row.url, headersFor(row, deps.userAgent), {
              ...deps,
              onRateLimit: () => budget.noteRateLimit(host),
            }),
          );
        } catch (error) {
          process.stderr.write(`probe failed unexpectedly: ${String(error)}\n`);
          outcome = { state: 'blocked', reason: 'internal', ms: null };
        }
        tally[outcome.state] += 1;
        records.push({
          k: key,
          state: outcome.state,
          reason: outcome.reason,
          ms: outcome.ms,
          at: Date.now(),
        });
      }
    }
  }

  const workerCount = Math.max(1, Math.min(settings.concurrentHosts, hosts.length));
  await Promise.all(Array.from({ length: workerCount }, worker));

  const path = `${outDir()}/records-${settings.shard}.json`;
  await writeJson(path, {
    shard: settings.shard,
    shardCount: settings.shardCount,
    probed: records.length,
    records,
  });

  process.stderr.write(
    `shard ${settings.shard}: up ${tally.up}, down ${tally.down}, ` +
      `blocked ${tally.blocked}, skipped ${tally.skipped} -> ${path}\n`,
  );
}

await main();
