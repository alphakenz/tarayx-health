import { sha1Key } from './hash.ts';
import type { ChannelHealth, HealthFile, ProbeRecord, StateFile, StreamRow, StreamState } from './types.ts';

/**
 * State reduction and channel rollup.
 *
 * The down-streak counter is the safety property of this whole system. A stream is
 * only treated as dead once it has failed `minDownStreak` sweeps in a row, so one
 * DNS blip, one CDN outage, or one bad sweep cannot remove a channel. Any `up`
 * resets the counter immediately, and `blocked` and `skipped` leave it untouched
 * because neither is evidence.
 */

const EMPTY_STATE: StateFile = { version: 1, streams: {} };

function nextState(previous: StreamState | undefined, record: ProbeRecord): StreamState | null {
  switch (record.state) {
    case 'up':
      return { s: 'u', d: 0, a: record.at };
    case 'down': {
      // The streak counts down sweeps while ignoring intervening non-evidence
      // sweeps, so it continues from `d` whether the previous verdict was `d` or
      // `b`. Only a `up` clears it, and `up` sets `d` to 0 above.
      const streak = (previous?.d ?? 0) + 1;
      return { s: 'd', d: streak, a: record.at };
    }
    case 'blocked':
      // Preserves the previous streak: being refused is not a data point about
      // liveness, and a stream that was one sweep from `dead` stays there.
      return { s: 'b', d: previous?.d ?? 0, a: record.at };
    case 'skipped':
      return null;
    default:
      return null;
  }
}

/**
 * Folds this sweep's records into the carried-over state.
 *
 * `validKeys` prunes streams that have left the catalogue. Without it the state
 * document would grow without bound, and a stale entry is worse than no entry —
 * it would let a long-dead stream keep its streak alive indefinitely.
 */
export function reduceState(
  previous: StateFile,
  records: readonly ProbeRecord[],
  validKeys?: ReadonlySet<string>,
): StateFile {
  const streams: Record<string, StreamState> = {};
  for (const [key, value] of Object.entries(previous.streams)) {
    if (validKeys && !validKeys.has(key)) {
      continue;
    }
    streams[key] = value;
  }
  for (const record of records) {
    const updated = nextState(streams[record.k], record);
    if (updated !== null) {
      streams[record.k] = updated;
    }
  }
  return { version: 1, streams };
}

function verdictFor(state: StreamState, minDownStreak: number): ChannelHealth['state'] | 'other' {
  if (state.s === 'u') {
    return 'online';
  }
  if (state.s === 'd' && state.d >= minDownStreak) {
    return 'dead';
  }
  return 'other';
}

/**
 * Collapses stream verdicts into the per-channel verdicts the app consumes.
 *
 * A channel is `dead` only when every one of its streams is a *convinced* dead:
 * if even one stream is blocked, still fresh, or merely one sweep into a down
 * streak, the channel is `unknown`, and the app fails open and shows it. 7% of
 * the catalogue is geo-restricted, and collapsing those into "dead" is the single
 * worst mistake this feed could make.
 */
export function rollupChannels(
  streams: readonly StreamRow[],
  state: StateFile,
  minDownStreak: number,
): Record<string, ChannelHealth> {
  const byChannel = new Map<string, StreamState[]>();

  for (const row of streams) {
    if (row.channel === null) {
      continue;
    }
    const entry = state.streams[sha1Key(row.url)];
    if (entry === undefined) {
      continue;
    }
    const existing = byChannel.get(row.channel);
    if (existing) {
      existing.push(entry);
    } else {
      byChannel.set(row.channel, [entry]);
    }
  }

  const channels: Record<string, ChannelHealth> = {};
  for (const [id, entries] of byChannel) {
    let up = 0;
    let dead = 0;
    let restricted = false;

    for (const entry of entries) {
      const verdict = verdictFor(entry, minDownStreak);
      if (verdict === 'online') {
        up += 1;
      } else if (verdict === 'dead') {
        dead += 1;
      } else if (entry.s === 'b') {
        restricted = true;
      }
    }

    const total = entries.length;
    let channelState: ChannelHealth['state'];
    if (up > 0) {
      channelState = 'online';
    } else if (restricted || dead < total) {
      channelState = 'unknown';
    } else {
      channelState = 'dead';
    }

    channels[id] = { state: channelState, up, total, restricted };
  }

  return channels;
}

/** Builds the published document from a reduced state. */
export function buildHealthFile(options: {
  channels: Record<string, ChannelHealth>;
  region: string;
  generatedAt: number;
  streamsTotal: number;
  probed: number;
  minDownStreak: number;
}): HealthFile {
  return {
    version: 1,
    generated_at: options.generatedAt,
    region: options.region,
    probe: {
      streams_total: options.streamsTotal,
      probed: options.probed,
      min_down_streak: options.minDownStreak,
    },
    channels: options.channels,
  };
}

export { EMPTY_STATE };
