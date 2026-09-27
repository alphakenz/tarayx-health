import { isHtmlLike, looksLikePlaylist, readCapped } from './http.ts';
import { candidateSegments, firstVariant, parsePlaylist } from './playlist.ts';
import type { ProbeReason, ProbeState } from './types.ts';

/**
 * The probe ladder.
 *
 * A stream is only `up` once a real media byte has been read. A `200` and a
 * plausible content type are not evidence, because the dominant failure mode in
 * this catalogue is a URL that answers politely and then serves nothing: dead
 * variants behind a live playlist, an HTML error page, a CDN that 404s segments
 * from outside its region.
 *
 * The ladder is one HTTP request per step, and there is no separate TCP pre-check:
 * a failed connect already surfaces its own error code, so a dedicated socket
 * probe would cost an extra round trip per stream to learn nothing new.
 */

export type ProbeDeps = {
  fetchImpl: typeof fetch;
  now: () => number;
  requestTimeoutMs: number;
  segmentCapBytes: number;
  /** How many renditions of a master playlist to try before calling it dead. */
  maxVariants: number;
  /** How many segments of a rendition to try before calling it dead. */
  maxSegmentAttempts: number;
  userAgent: string;
  /** Invoked when any request in the ladder drew a `429`. */
  onRateLimit?: () => void;
};

export type Outcome = {
  state: ProbeState;
  reason: ProbeReason;
  ms: number | null;
};

/** A terminal classification, carried as a value so the ladder reads as a list of steps. */
class Failure {
  readonly state: ProbeState;
  readonly reason: ProbeReason;

  constructor(state: ProbeState, reason: ProbeReason) {
    this.state = state;
    this.reason = reason;
  }
}

/** Apple and community HLS content types, matched case-insensitively. */
const PLAYLIST_CONTENT_TYPES = /mpegurl|application\/vnd\.apple/i;

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * Maps a transport failure onto a verdict.
 *
 * `ENOTFOUND` is the one DNS verdict treated as proof of death. Everything that
 * could plausibly be regional — a refused or reset connection, a timeout, a
 * certificate the prober does not trust — is `blocked`, because those describe
 * this runner's path to the origin and not the origin's health.
 */
function classifyTransportError(error: unknown): Failure {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new Failure('blocked', 'timeout');
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  const cause =
    typeof error === 'object' && error !== null && 'cause' in error
      ? (error as { cause?: unknown }).cause
      : null;
  const causeCode =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? String((cause as { code?: unknown }).code ?? '')
      : '';
  const both = `${code} ${causeCode}`;

  if (both.includes('ENOTFOUND') || both.includes('EAI_AGAIN')) {
    return new Failure('down', 'dns');
  }
  if (/CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|DEPTH_ZERO/i.test(both)) {
    return new Failure('blocked', 'tls');
  }
  if (
    both.includes('ECONNREFUSED') ||
    both.includes('ECONNRESET') ||
    both.includes('ETIMEDOUT') ||
    both.includes('EHOSTUNREACH') ||
    both.includes('ENETUNREACH') ||
    both.includes('UND_ERR_CONNECT_TIMEOUT') ||
    both.includes('UND_ERR_SOCKET')
  ) {
    return new Failure('down', 'connect');
  }
  // Anything unrecognised is a fact about us, not about the stream.
  return new Failure('blocked', 'timeout');
}

/**
 * Maps an HTTP status onto a verdict.
 *
 * Only 404 and 410 assert that the resource is gone. Everything else — including
 * every 5xx — is `blocked`, because a server that is refusing or failing us says
 * nothing reliable about whether the stream plays for a viewer elsewhere.
 */
function classifyStatus(status: number): Failure | null {
  if (status >= 200 && status < 300) {
    return null;
  }
  if (status === 404 || status === 410) {
    return new Failure('down', 'http_gone');
  }
  if (status === 401 || status === 403 || status === 429 || status === 451) {
    return new Failure('blocked', 'http_forbidden');
  }
  if (status >= 500) {
    return new Failure('blocked', 'http_server_error');
  }
  if (status >= 400) {
    return new Failure('blocked', 'http_unexpected');
  }
  // 3xx here means a redirect chain the runtime could not resolve.
  return new Failure('blocked', 'http_unexpected');
}

type FetchOutcome =
  | { ok: true; response: Response; ttfbMs: number }
  | { ok: false; failure: Failure };

async function timedFetch(
  url: string,
  init: RequestInit,
  deps: ProbeDeps,
): Promise<FetchOutcome> {
  const started = deps.now();
  try {
    const response = await deps.fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(deps.requestTimeoutMs),
    });
    return { ok: true, response, ttfbMs: deps.now() - started };
  } catch (error) {
    return { ok: false, failure: classifyTransportError(error) };
  }
}

/**
 * Reports a `429` to the caller so it can stop asking this host.
 *
 * The rate-limit signal has to come from every rung of the ladder, not just the
 * first request, because a master playlist can return 200 and then 429 the
 * variant fetch. Wiring it through `deps` keeps the prober free of any transport
 * policy of its own.
 */
function noteRateLimit(response: Response, deps: ProbeDeps): void {
  if (response.status === 429) {
    deps.onRateLimit?.();
  }
}

async function getBody(
  url: string,
  headers: Record<string, string>,
  deps: ProbeDeps,
  cap: number,
  range?: string,
): Promise<{ ok: true; bytes: Uint8Array; contentType: string | null; ttfbMs: number } | { ok: false; failure: Failure }> {
  const result = await timedFetch(
    url,
    { method: 'GET', headers: range ? { ...headers, Range: range } : headers, redirect: 'follow' },
    deps,
  );
  if (!result.ok) {
    return result;
  }
  noteRateLimit(result.response, deps);
  const status = classifyStatus(result.response.status);
  if (status) {
    return { ok: false, failure: status };
  }
  let bytes: Uint8Array;
  try {
    bytes = await readCapped(result.response, cap);
  } catch (error) {
    // The request timeout stays armed once headers arrive, so it can fire part way
    // through the body — and a live HLS segment, which never ends, is exactly the
    // case that reaches the cap by timing out rather than by finishing. Left
    // uncaught that rejection escapes the ladder and takes the whole shard down
    // with it, so the sweep loses thousands of completed probes over one stream.
    // A body that stops mid-read is a transport failure, never evidence of death.
    return { ok: false, failure: classifyTransportError(error) };
  }
  return {
    ok: true,
    bytes,
    contentType: result.response.headers.get('content-type'),
    ttfbMs: result.ttfbMs,
  };
}

/**
 * Re-labels a failure with the stage it happened at.
 *
 * Only a `404`/`410` is re-labelled, because that is the one case where the stage
 * is the interesting fact: "a segment behind a valid playlist is gone" is the
 * dominant real-world failure here and is invisible if every 404 collapses to the
 * same code. Transport-level reasons are left alone, since `timeout` or
 * `http_forbidden` already says more than the stage would.
 */
function withStage(failure: Failure, stage: 'variant' | 'segment'): Failure {
  if (failure.reason !== 'http_gone') {
    return failure;
  }
  return new Failure(failure.state, stage === 'variant' ? 'variant_failed' : 'segment_failed');
}

/**
 * Confirms a media URI really yields media.
 *
 * This is the step that separates "responds" from "plays": a `206` of 1,525 bytes
 * is a live segment, and the `404` of 146 bytes behind a valid playlist is a dead
 * stream. Byte-magic validation is deliberately *not* applied — sampled segments
 * began `##XT` (an ad-marker preamble) and `ID3`-tagged TS, so only an HTML or
 * playlist body counts as a failure.
 */
async function verifyMedia(
  url: string,
  headers: Record<string, string>,
  deps: ProbeDeps,
): Promise<Failure | number> {
  const result = await getBody(
    url,
    headers,
    deps,
    deps.segmentCapBytes,
    `bytes=0-${deps.segmentCapBytes - 1}`,
  );
  if (!result.ok) {
    return withStage(result.failure, 'segment');
  }
  if (result.bytes.length === 0) {
    return new Failure('down', 'segment_not_media');
  }
  if (isHtmlLike(result.contentType, result.bytes) || looksLikePlaylist(result.bytes)) {
    return new Failure('down', 'segment_not_media');
  }
  return result.ttfbMs;
}

/**
 * Walks master → rendition → media.
 *
 * Several renditions are tried before declaring a master playlist dead, because a
 * single dead variant is common and a player would simply pick another one.
 */
async function verifyChain(
  headers: Record<string, string>,
  playlistBody: { bytes: Uint8Array; contentType: string | null; ttfbMs: number },
  playlistUrl: string,
  deps: ProbeDeps,
): Promise<Failure | number> {
  const playlist = parsePlaylist(
    new TextDecoder('utf-8', { fatal: false }).decode(playlistBody.bytes),
    playlistUrl,
  );

  if (playlist.kind === 'invalid') {
    return new Failure('down', 'not_a_playlist');
  }

  if (playlist.kind === 'master') {
    const candidates = playlist.variants.slice(0, deps.maxVariants);
    if (candidates.length === 0) {
      return new Failure('down', 'empty_playlist');
    }
    let last: Failure = new Failure('down', 'variant_failed');
    for (const variant of candidates) {
      const variantBody = await getBody(variant, headers, deps, 64 * 1024);
      if (!variantBody.ok) {
        // A rendition we are forbidden or throttled from tells us nothing about the
        // other renditions, so stop rather than hammer the origin.
        if (variantBody.failure.reason === 'http_forbidden') {
          return variantBody.failure;
        }
        last = withStage(variantBody.failure, 'variant');
        continue;
      }
      const rendition = parsePlaylist(
        new TextDecoder('utf-8', { fatal: false }).decode(variantBody.bytes),
        variant,
      );
      if (rendition.kind === 'master') {
        // A master pointing at another master still has to end in media, but only
        // one level of nesting is followed; a deeper cycle is a dead stream.
        const nested = firstVariant(rendition);
        if (nested === null) {
          last = new Failure('down', 'empty_playlist');
          continue;
        }
        return await verifyMedia(nested, headers, deps);
      }
      if (rendition.kind === 'invalid') {
        last = new Failure('down', 'not_a_playlist');
        continue;
      }
      const verified = await verifyRendition(rendition, headers, deps);
      if (typeof verified === 'number') {
        return verified;
      }
      last = verified;
    }
    return last;
  }

  return await verifyRendition(playlist, headers, deps);
}

/** Checks the fMP4 init segment and then the media segments of a rendition. */
async function verifyRendition(
  rendition: { kind: 'media'; segments: string[]; init: string | null; live: boolean },
  headers: Record<string, string>,
  deps: ProbeDeps,
): Promise<Failure | number> {
  if (rendition.segments.length === 0) {
    return new Failure('down', 'empty_playlist');
  }
  if (rendition.init) {
    // An initialisation segment is a static file, not part of the sliding window,
    // so it can be checked directly.
    const init = await verifyMedia(rendition.init, headers, deps);
    if (typeof init !== 'number') {
      return init;
    }
  }

  // Several candidates are tried before the stream is called dead, because a live
  // window moves underneath the probe. See `candidateSegments`.
  const candidates = candidateSegments(rendition.segments, rendition.live).slice(0, deps.maxSegmentAttempts);
  let last: Failure = new Failure('down', 'segment_failed');
  for (const segment of candidates) {
    const result = await verifyMedia(segment, headers, deps);
    if (typeof result === 'number') {
      return result;
    }
    // Being refused or throttled says nothing about the other segments, and the
    // origin has asked us to back off, so stop rather than keep hammering it.
    if (result.reason === 'http_forbidden') {
      return result;
    }
    last = result;
  }
  return last;
}

/**
 * Probes one stream URL.
 *
 * `headers` carries the `User-Agent` and `Referer` the dataset declares for this
 * stream. 789 rows declare a user agent and 324 a referrer, and a prober that
 * ignores them reports those streams as `403` — a false negative created purely
 * by not asking the way the catalogue says to ask. Where the dataset declares
 * nothing, an honest prober identity is sent rather than a browser string.
 */
export async function probeStream(
  url: string,
  headers: Record<string, string>,
  deps: ProbeDeps,
): Promise<Outcome> {
  if (!isHttpUrl(url)) {
    // expo-video cannot play rtsp/rtmp/udp either, so for this feed they are
    // proof that the channel is unplayable rather than a regional unknown.
    return { state: 'down', reason: 'unsupported_scheme', ms: null };
  }

  const body = await getBody(url, headers, deps, 64 * 1024);
  if (!body.ok) {
    return { state: body.failure.state, reason: body.failure.reason, ms: null };
  }

  const looksHls =
    url.toLowerCase().includes('.m3u8') ||
    (body.contentType !== null && PLAYLIST_CONTENT_TYPES.test(body.contentType));

  if (isHtmlLike(body.contentType, body.bytes)) {
    return { state: 'down', reason: 'html_body', ms: null };
  }

  if (!looksHls) {
    // A progressive stream cannot be range-verified, but a 2xx body that is not an
    // error page is the strongest evidence available for one.
    return body.bytes.length > 0
      ? { state: 'up', reason: 'ok', ms: body.ttfbMs }
      : { state: 'down', reason: 'segment_not_media', ms: null };
  }

  const verified = await verifyChain(headers, body, url, deps);
  if (typeof verified === 'number') {
    return { state: 'up', reason: 'ok', ms: verified };
  }
  return { state: verified.state, reason: verified.reason, ms: null };
}
