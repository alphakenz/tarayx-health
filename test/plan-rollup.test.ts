import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashUnit, sha1Key, shardOf } from '../src/hash.ts';
import { HostBudget, parseRetryAfter, groupByHost } from '../src/host-budget.ts';
import { planProbes } from '../src/plan.ts';
import { reduceState, rollupChannels } from '../src/rollup.ts';
import { normalizeCatalog, normalizeRow } from '../src/streams.ts';
import type { ProbeRecord, StateFile, StreamRow } from '../src/types.ts';

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function row(url: string, channel: string | null = 'ch1'): StreamRow {
  return { channel, title: 't', url, referrer: null, user_agent: null, quality: null };
}

function emptyState(): StateFile {
  return { version: 1, streams: {} };
}

function plan(streams: StreamRow[], state: StateFile, overrides: Record<string, number> = {}) {
  return planProbes(streams, state, {
    now: NOW,
    shard: 0,
    shardCount: 1,
    upFreshMs: 6 * HOUR,
    upSamplePercent: 20,
    downRevisitMs: 2 * HOUR,
    maxProbes: 10_000,
    maxPerHost: 40,
    ...overrides,
  });
}

test('state keys are short, stable and URL-specific', () => {
  const key = sha1Key('https://x.test/a.m3u8');
  assert.equal(key.length, 16);
  assert.equal(key, sha1Key('https://x.test/a.m3u8'));
  assert.notEqual(key, sha1Key('https://x.test/b.m3u8'));
});

test('hashUnit is deterministic and in range', () => {
  for (const url of ['a', 'b', 'c', 'd', 'e']) {
    const value = hashUnit(url);
    assert.equal(value, hashUnit(url));
    assert.ok(value >= 0 && value < 1, `${value} in range`);
  }
});

test('sharding keeps a host whole in one shard', () => {
  for (let index = 0; index < 50; index += 1) {
    const host = `host${index}.test`;
    assert.equal(shardOf(host, 4), shardOf(host, 4));
    assert.ok(shardOf(host, 4) >= 0 && shardOf(host, 4) < 4);
  }
});

test('a stream never probed is always probed', () => {
  const result = plan([row('https://a.test/1.m3u8'), row('https://b.test/1.m3u8')], emptyState());
  assert.equal(result.selected.length, 2);
  assert.equal(result.stats.neverSeen, 2);
});

test('a fresh up result is not re-probed', () => {
  const url = 'https://a.test/1.m3u8';
  const state: StateFile = { version: 1, streams: { [sha1Key(url)]: { s: 'u', d: 0, a: NOW - HOUR } } };
  assert.equal(plan([row(url)], state).selected.length, 0);
});

test('a stale up result joins the sample instead of being polled every sweep', () => {
  // 20% sampling: identical plans across runs, but a subset overall.
  const picked = Array.from({ length: 200 }, (_unused, index) => row(`https://a.test/${index}.m3u8`));
  const keys = new Set(picked.map((stream) => sha1Key(stream.url)));
  const result = plan(picked, { version: 1, streams: {} }, { upSamplePercent: 100, maxPerHost: 1000 });
  assert.equal(result.selected.length, 200);

  const sampled = plan(
    picked,
    {
      version: 1,
      streams: Object.fromEntries(
        picked.map((stream) => [sha1Key(stream.url), { s: 'u', d: 0, a: NOW - 10 * HOUR }]),
      ),
    },
    { upSamplePercent: 20, maxPerHost: 1000 },
  );
  const fraction = sampled.selected.length / picked.length;
  assert.ok(fraction > 0.05 && fraction < 0.4, `sampled ${fraction} of healthy streams`);
  for (const stream of sampled.selected) {
    assert.ok(keys.has(sha1Key(stream.url)));
  }
});

test('the sample is stable across identical runs', () => {
  const picked = Array.from({ length: 50 }, (_unused, index) => row(`https://a.test/${index}.m3u8`));
  const state: StateFile = {
    version: 1,
    streams: Object.fromEntries(
      picked.map((stream) => [sha1Key(stream.url), { s: 'u', d: 0, a: NOW - 10 * HOUR }]),
    ),
  };
  const first = plan(picked, state).selected.map((stream) => stream.url);
  const second = plan(picked, state).selected.map((stream) => stream.url);
  assert.deepEqual(first, second);
});

test('a down stream is re-probed every sweep', () => {
  const url = 'https://a.test/1.m3u8';
  const state: StateFile = { version: 1, streams: { [sha1Key(url)]: { s: 'd', d: 1, a: NOW - 3 * HOUR } } };
  const result = plan([row(url)], state);
  assert.equal(result.selected.length, 1);
  assert.equal(result.stats.revisitDown, 1);
});

test('a blocked stream is resampled rather than polled', () => {
  const url = 'https://a.test/1.m3u8';
  const fresh: StateFile = { version: 1, streams: { [sha1Key(url)]: { s: 'b', d: 0, a: NOW - HOUR } } };
  assert.equal(plan([row(url)], fresh).selected.length, 0);
});

test('a shard only takes its own hosts', () => {
  const rows = Array.from({ length: 60 }, (_unused, index) => row(`https://host${index}.test/1.m3u8`));
  const seen = new Set<number>();
  for (let shard = 0; shard < 4; shard += 1) {
    const result = plan(rows, emptyState(), { shard, shardCount: 4 });
    seen.add(result.selected.length);
    for (const stream of result.selected) {
      assert.equal(shardOf(new URL(stream.url).host, 4), shard);
    }
  }
  // The four shards partition the catalogue rather than all taking all of it.
  assert.ok([...seen].every((count) => count > 0), 'every shard gets work');
});

test('per-host and total caps are enforced', () => {
  const rows = Array.from({ length: 200 }, () => row('https://big.test/1.m3u8'));
  const result = plan(rows, emptyState(), { maxPerHost: 10 });
  assert.equal(result.selected.length, 10);
  assert.equal(result.stats.capped, 190);

  const total = plan(rows, emptyState(), { maxPerHost: 40, maxProbes: 25 });
  assert.equal(total.selected.length, 25);
});

test('unknown streams outrank down streaks, which outrank resamples', () => {
  const unknown = row('https://new.test/1.m3u8');
  const down = row('https://down.test/1.m3u8');
  const sampled = row('https://ok.test/1.m3u8');
  const state: StateFile = {
    version: 1,
    streams: {
      [sha1Key(down.url)]: { s: 'd', d: 1, a: NOW - 10 * HOUR },
      [sha1Key(sampled.url)]: { s: 'u', d: 0, a: NOW - 10 * HOUR },
    },
  };
  const result = plan([sampled, down, unknown], state, { upSamplePercent: 100 });
  assert.deepEqual(
    result.selected.map((stream) => stream.url),
    [unknown.url, down.url, sampled.url],
  );
});

test('reduceState advances, clears and preserves streaks correctly', () => {
  const url = 'https://a.test/1.m3u8';
  const key = sha1Key(url);
  const record = (state: ProbeRecord['state'], at: number): ProbeRecord => ({
    k: key,
    state,
    reason: 'ok',
    ms: null,
    at,
  });

  let state = reduceState(emptyState(), [record('down', NOW)]);
  assert.deepEqual(state.streams[key], { s: 'd', d: 1, a: NOW });

  state = reduceState(state, [record('down', NOW + HOUR)]);
  assert.equal(state.streams[key]?.d, 2);

  // A block is not evidence: the streak must survive it.
  state = reduceState(state, [record('blocked', NOW + 2 * HOUR)]);
  assert.equal(state.streams[key]?.s, 'b');
  assert.equal(state.streams[key]?.d, 2);

  // Being skipped is not evidence either.
  state = reduceState(state, [record('skipped', NOW + 3 * HOUR)]);
  assert.equal(state.streams[key]?.s, 'b');
  assert.equal(state.streams[key]?.d, 2);

  state = reduceState(state, [record('down', NOW + 4 * HOUR)]);
  assert.equal(state.streams[key]?.d, 3, 'the streak is consecutive, blocked sweeps ignored');

  state = reduceState(state, [record('up', NOW + 5 * HOUR)]);
  assert.equal(state.streams[key]?.s, 'u');
  assert.equal(state.streams[key]?.d, 0, 'one success clears the streak');

  // A skipped record on its own must not create state.
  const fresh = reduceState(emptyState(), [record('skipped', NOW)]);
  assert.equal(fresh.streams[key], undefined);
});

test('streams that leave the catalogue are pruned', () => {
  const gone = row('https://gone.test/1.m3u8');
  const state = reduceState(emptyState(), [
    { k: sha1Key(gone.url), state: 'down', reason: 'ok', ms: null, at: NOW },
  ]);
  assert.ok(state.streams[sha1Key(gone.url)]);
  const pruned = reduceState(state, [], new Set(['some-other-key']));
  assert.equal(pruned.streams[sha1Key(gone.url)], undefined);
});

test('a channel whose only stream is confidently dead is dead', () => {
  const rows = [row('https://a.test/1.m3u8'), row('https://b.test/1.m3u8', 'ch2')];
  const state: StateFile = {
    version: 1,
    streams: {
      [sha1Key(rows[0]!.url)]: { s: 'd', d: 9, a: NOW },
      [sha1Key(rows[1]!.url)]: { s: 'u', d: 0, a: NOW },
    },
  };
  const channels = rollupChannels(rows, state, 2);
  assert.equal(channels.ch1?.state, 'dead');
  assert.equal(channels.ch2?.state, 'online');
});

test('one working stream makes a channel online regardless of the others', () => {
  const rows = [row('https://a.test/1.m3u8'), row('https://b.test/1.m3u8')];
  const state: StateFile = {
    version: 1,
    streams: {
      [sha1Key(rows[0]!.url)]: { s: 'd', d: 9, a: NOW },
      [sha1Key(rows[1]!.url)]: { s: 'u', d: 0, a: NOW },
    },
  };
  const health = rollupChannels(rows, state, 2).ch1;
  assert.equal(health?.state, 'online');
  assert.equal(health?.up, 1);
  assert.equal(health?.total, 2);
});

test('a channel is dead only when every stream has a full down streak', () => {
  const rows = [row('https://a.test/1.m3u8'), row('https://b.test/1.m3u8')];
  const oneSweepOnly: StateFile = {
    version: 1,
    streams: {
      [sha1Key(rows[0]!.url)]: { s: 'd', d: 1, a: NOW },
      [sha1Key(rows[1]!.url)]: { s: 'd', d: 1, a: NOW },
    },
  };
  const channels = rollupChannels(rows, oneSweepOnly, 2);
  // One sweep of failures is not a verdict, so both must stay visible.
  assert.equal(channels.ch1?.state, 'unknown');

  const twoSweeps: StateFile = {
    version: 1,
    streams: {
      [sha1Key(rows[0]!.url)]: { s: 'd', d: 2, a: NOW },
      [sha1Key(rows[1]!.url)]: { s: 'd', d: 2, a: NOW },
    },
  };
  assert.equal(rollupChannels(rows, twoSweeps, 2).ch1?.state, 'dead');
});

test('a single blocked stream keeps a channel visible', () => {
  // The 7% geo-restricted case: hiding these is the worst mistake this feed could make.
  const rows = [row('https://a.test/1.m3u8'), row('https://b.test/1.m3u8')];
  const state: StateFile = {
    version: 1,
    streams: {
      [sha1Key(rows[0]!.url)]: { s: 'd', d: 9, a: NOW },
      [sha1Key(rows[1]!.url)]: { s: 'b', d: 0, a: NOW },
    },
  };
  const health = rollupChannels(rows, state, 2).ch1;
  assert.equal(health?.state, 'unknown');
  assert.equal(health?.restricted, true);
  assert.equal(health?.up, 0);
});

test('channels with no known streams are omitted rather than assumed dead', () => {
  const rows = [row('https://a.test/1.m3u8')];
  assert.deepEqual(rollupChannels(rows, emptyState(), 2), {});
});

test('streams without a channel id are not rolled up', () => {
  const rows = [row('https://a.test/1.m3u8', null)];
  const state: StateFile = {
    version: 1,
    streams: { [sha1Key(rows[0]!.url)]: { s: 'u', d: 0, a: NOW } },
  };
  assert.deepEqual(rollupChannels(rows, state, 2), {});
});

test('catalogue rows are normalised and unusable ones dropped', () => {
  assert.equal(normalizeRow({ url: 'http://x.test/a.m3u8', channel: 'c' })?.channel, 'c');
  // Non-HTTP schemes pass through so the prober can record a real verdict for them.
  assert.equal(normalizeRow({ url: 'rtmp://x.test/a' })?.url, 'rtmp://x.test/a');
  assert.equal(normalizeRow({ url: 'x.test/a' }), null, 'a relative URL is unusable');
  assert.equal(normalizeRow({ channel: 'c' }), null, 'no url is unusable');
  assert.equal(normalizeRow('nope'), null);
  assert.equal(normalizeRow({ url: 'https://x.test/a', title: '' })?.title, 'https://x.test/a');
});

test('duplicate URLs are collapsed so a stream is not counted twice', () => {
  const rows = normalizeCatalog([
    { url: 'https://a.test/1.m3u8', channel: 'c1' },
    { url: 'https://a.test/1.m3u8', channel: 'c1' },
    { url: 'https://b.test/1.m3u8', channel: 'c2' },
    { url: 42 },
  ]);
  assert.equal(rows.length, 2);
});

test('a non-array catalogue is rejected', () => {
  assert.throws(() => normalizeCatalog({ streams: [] }), TypeError);
});

test('groupByHost groups by host and skips unparseable URLs', () => {
  const groups = groupByHost([row('https://a.test/1.m3u8'), row('https://a.test/2.m3u8'), row('https://b.test/1.m3u8')]);
  assert.equal(groups.get('a.test')?.length, 2);
  assert.equal(groups.get('b.test')?.length, 1);
});

test('HostBudget serialises requests per host and spaces them out', async () => {
  const budget = new HostBudget({ minSpacingMs: 5, tripAfter: 3 });
  const order: string[] = [];
  let clock = 0;
  const now = (): number => clock;

  const work = (label: string) =>
    budget.run(
      'a.test',
      async () => {
        order.push(`start:${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end:${label}`);
      },
      now,
    );

  clock = 0;
  await Promise.all([work('a'), work('b'), work('c')]);

  // No overlap: every start is immediately followed by its own end, in order.
  assert.equal(order.length, 6);
  for (let index = 0; index < order.length; index += 2) {
    assert.equal(
      order[index]?.replace('start:', ''),
      order[index + 1]?.replace('end:', ''),
      'requests to one host must not interleave',
    );
  }
});

test('HostBudget trips a host after repeated rate limits', () => {
  const budget = new HostBudget({ tripAfter: 3 });
  assert.equal(budget.isTripped('a.test'), false);
  budget.noteRateLimit('a.test');
  budget.noteRateLimit('a.test');
  assert.equal(budget.isTripped('a.test'), false);
  budget.noteRateLimit('a.test');
  assert.equal(budget.isTripped('a.test'), true);
  assert.equal(budget.isTripped('b.test'), false, 'trips are per host');
});

test('HostBudget takes a Retry-After cooldown at face value', () => {
  const budget = new HostBudget({ tripAfter: 3 });
  // One instruction from the server is worth three bare 429s: it said when to
  // come back, so asking again this sweep is the worse neighbour.
  budget.noteRateLimit('a.test', 120);
  assert.equal(budget.isTripped('a.test'), true);
});

test('HostBudget releases a Retry-After cooldown once it expires', () => {
  let now = 1_000_000;
  const budget = new HostBudget({ tripAfter: 3, now: () => now });
  budget.noteRateLimit('a.test', 60);
  assert.equal(budget.isTripped('a.test'), true);

  now += 59_000;
  assert.equal(budget.isTripped('a.test'), true, 'still inside the window');

  now += 2_000;
  assert.equal(budget.isTripped('a.test'), false, 'the host asked us back');
});

test('HostBudget ignores a Retry-After it cannot use', () => {
  // A malformed or non-positive header must not silently outvote the strike
  // counter, which is the conservative reading.
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const budget = new HostBudget({ tripAfter: 3 });
    budget.noteRateLimit('a.test', bad);
    budget.noteRateLimit('a.test', bad);
    assert.equal(budget.isTripped('a.test'), false, `Retry-After ${bad} should not trip`);
    budget.noteRateLimit('a.test', bad);
    assert.equal(budget.isTripped('a.test'), true, `Retry-After ${bad} should still count`);
  }
});

test('HostBudget caps an absurd Retry-After', () => {
  // A sweep is minutes long, so a day-long cooldown skips the host regardless;
  // the cap only stops a hostile header from outliving any possible run.
  let now = 0;
  const budget = new HostBudget({ tripAfter: 3, now: () => now });
  budget.noteRateLimit('a.test', 86_400);
  assert.equal(budget.isTripped('a.test'), true);
  now += 60 * 60 * 1000 + 1;
  assert.equal(budget.isTripped('a.test'), false);
});

test('parseRetryAfter only accepts a usable delta-seconds value', () => {
  assert.equal(parseRetryAfter(30), 30_000);
  assert.equal(parseRetryAfter(0), null);
  assert.equal(parseRetryAfter(-1), null);
  assert.equal(parseRetryAfter(Number.NaN), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(undefined), null);
  // The HTTP-date form is legal but deliberately not honoured.
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT' as unknown as number), null);
});
