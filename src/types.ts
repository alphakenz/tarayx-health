/**
 * The verdict for one stream URL after a full ladder probe.
 *
 * The split between `down` and `blocked` is the single most important decision in
 * this repo, because the app hides channels whose every stream is `down`. A
 * `down` must therefore be positive evidence that the stream is dead, and nothing
 * else may claim to be:
 *
 * - `down`   — the origin told us the resource is not there: NXDOMAIN, nothing
 *              listening, 404/410, an HTML error page where a playlist should be,
 *              or a playlist whose variant/segment is itself gone.
 * - `blocked`— we could not get it, but that is a fact about *this prober*, not
 *              about the stream: 401/403 (geo or token), 429, any 5xx, a TLS
 *              error, or a timeout. A US runner timing out on an Australian-only
 *              CDN is the canonical false negative, and it must never hide a
 *              channel for a viewer who could have watched it.
 * - `skipped`— the probe never ran (host rate-limited, shard excluded). Carries
 *              no evidence at all, so it must not move any counter.
 */
export type ProbeState = 'up' | 'down' | 'blocked' | 'skipped';

export type ProbeReason =
  | 'ok'
  | 'dns'
  | 'connect'
  | 'timeout'
  | 'tls'
  | 'rate_limited'
  | 'http_forbidden'
  | 'http_server_error'
  | 'http_gone'
  | 'http_unexpected'
  | 'html_body'
  | 'not_a_playlist'
  | 'empty_playlist'
  | 'variant_failed'
  | 'segment_failed'
  | 'segment_not_media'
  | 'unsupported_scheme'
  | 'shard_excluded'
  | 'host_skipped';

/** A single probe outcome, keyed by URL hash so state stays small on disk. */
export type ProbeRecord = {
  /** `sha1(url)` truncated — the state key, and stable across sweeps. */
  k: string;
  state: ProbeState;
  reason: ProbeReason;
  /** Time to first byte of the first media byte, in ms. `null` when not reached. */
  ms: number | null;
  at: number;
};

/**
 * Cross-sweep memory, published alongside the feed and read back by the next run.
 *
 * Keyed by URL hash. `d` is what makes hiding safe: a stream is only retired
 * after `d` consecutive down sweeps, so one bad sweep, one host hiccup or one
 * regional network fault cannot remove a channel from anyone's list.
 */
export type StateFile = {
  version: 1;
  streams: Record<string, StreamState>;
};

export type StreamState = {
  /** `u` up, `d` down, `b` blocked, `x` skipped. */
  s: 'u' | 'd' | 'b' | 'x';
  /** Consecutive down sweeps. Reset to 0 by any `up`. Never moved by `blocked`. */
  d: number;
  /** Epoch ms of the last completed probe. */
  a: number;
};

/** The per-channel verdict the app actually consumes. */
export type ChannelHealth = {
  state: 'online' | 'dead' | 'unknown';
  up: number;
  total: number;
  /** At least one stream failed in a way that says nothing about liveness. */
  restricted: boolean;
};

/** The published document. Bump `version` on any shape change. */
export type HealthFile = {
  version: 1;
  generated_at: number;
  region: string;
  /** A human-readable note about how the sweep was configured. */
  probe: {
    streams_total: number;
    probed: number;
    min_down_streak: number;
  };
  channels: Record<string, ChannelHealth>;
};

/** The subset of an iptv-org `streams.json` row this repo needs. */
export type StreamRow = {
  channel: string | null;
  title: string;
  url: string;
  referrer: string | null;
  user_agent: string | null;
  quality: string | null;
};
