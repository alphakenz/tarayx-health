import { sha1Key } from './hash.ts';
import { isRecord, listFiles, loadState, outDir, publicDir, readJson, settings, writeJson } from './io.ts';
import { buildHealthFile, reduceState, rollupChannels } from './rollup.ts';
import { fetchCatalog } from './streams.ts';
import type { ProbeRecord } from './types.ts';

/**
 * Folds every shard's records into the published feed.
 *
 * This is the only step that writes state, and the only one that publishes. Two
 * properties matter more than anything else here:
 *
 * 1. It reads the previous state or it publishes nothing. A merge that started
 *    from an empty state would zero every down streak and publish that as fresh
 *    evidence, retiring live channels. `loadState` throws rather than falling back.
 * 2. A missing shard is survivable. Its streams simply keep their previous
 *    verdicts, because `reduceState` only folds in the records it was given. A
 *    partially failed sweep is stale, not wrong — and stale is safe, since the app
 *    fails open on age.
 */

function extractRecords(value: unknown): ProbeRecord[] {
  if (!isRecord(value) || !Array.isArray(value.records)) {
    return [];
  }
  const out: ProbeRecord[] = [];
  for (const raw of value.records) {
    if (
      isRecord(raw) &&
      typeof raw.k === 'string' &&
      typeof raw.state === 'string' &&
      typeof raw.reason === 'string' &&
      typeof raw.at === 'number'
    ) {
      out.push({
        k: raw.k,
        state: raw.state as ProbeRecord['state'],
        reason: raw.reason as ProbeRecord['reason'],
        ms: typeof raw.ms === 'number' ? raw.ms : null,
        at: raw.at,
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const dir = outDir();
  const files = await listFiles(dir, 'records-');
  if (files.length === 0) {
    throw new Error(`no shard records found in ${dir}`);
  }

  const previous = await loadState();
  const catalog = await fetchCatalog();
  const validKeys = new Set(catalog.map((row) => sha1Key(row.url)));

  const records: ProbeRecord[] = [];
  const shardsSeen = new Set<number>();
  for (const name of files) {
    const parsed = await readJson(`${dir}/${name}`);
    if (isRecord(parsed) && typeof parsed.shard === 'number') {
      shardsSeen.add(parsed.shard);
    }
    const batch = extractRecords(parsed);
    records.push(...batch);
    process.stderr.write(`merged ${name}: ${batch.length} records\n`);
  }

  for (let shard = 0; shard < settings.shardCount; shard += 1) {
    if (!shardsSeen.has(shard)) {
      process.stderr.write(
        `warning: shard ${shard} produced no records; its streams keep their previous verdicts\n`,
      );
    }
  }

  const state = reduceState(previous, records, validKeys);
  const channels = rollupChannels(catalog, state, settings.minDownStreak);

  let online = 0;
  let dead = 0;
  let unknown = 0;
  for (const health of Object.values(channels)) {
    if (health.state === 'online') {
      online += 1;
    } else if (health.state === 'dead') {
      dead += 1;
    } else {
      unknown += 1;
    }
  }

  const healthFile = buildHealthFile({
    channels,
    region: process.env.REGION ?? 'us',
    generatedAt: Date.now(),
    streamsTotal: catalog.length,
    probed: records.length,
    minDownStreak: settings.minDownStreak,
  });

  await writeJson(`${publicDir()}/health.json`, healthFile);
  await writeJson(`${publicDir()}/health-state.json`, state);

  process.stderr.write(
    `published ${Object.keys(channels).length} channels ` +
      `(online ${online}, dead ${dead}, unknown ${unknown}) from ${records.length} probes\n`,
  );
}

await main();
