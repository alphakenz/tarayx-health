import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateSegments } from '../src/playlist.ts';
import { probeStream } from '../src/probe.ts';
import type { ProbeDeps } from '../src/probe.ts';

type Route = {
  status?: number;
  body?: string | Uint8Array;
  contentType?: string;
  /** Thrown instead of responding, to simulate a transport failure. */
  throws?: unknown;
};

type Call = { url: string; headers: Record<string, string>; ranged: boolean; hasSignal: boolean };

const MEDIA = 'video/mp2t';
const PLAYLIST = 'application/vnd.apple.mpegurl';

function stub(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // `Headers` lowercases names, so record them the same way rather than relying
    // on the casing the prober happened to use.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    calls.push({
      url,
      headers,
      ranged: 'range' in headers,
      hasSignal: init?.signal !== undefined && init.signal !== null,
    });
    const route = routes[url];
    if (route === undefined) {
      return new Response('no route', { status: 500 });
    }
    if (route.throws !== undefined) {
      throw route.throws;
    }
    return new Response((route.body ?? '') as BodyInit, {
      status: route.status ?? 200,
      headers: route.contentType === undefined ? {} : { 'content-type': route.contentType },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function deps(impl: typeof fetch, overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    fetchImpl: impl,
    now: () => 0,
    requestTimeoutMs: 1000,
    segmentCapBytes: 1024,
    maxVariants: 3,
    maxSegmentAttempts: 4,
    userAgent: 'TarayxHealth/test',
    ...overrides,
  };
}

function transportError(code: string, name?: string): unknown {
  const error = new Error(`${code}`);
  if (name !== undefined) {
    error.name = name;
  }
  (error as { code?: string }).code = code;
  return error;
}

const MEDIA_BODY = new Uint8Array([0x47, 0x40, 0x00, 0x10]);
const PLAYLIST_BODY = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.ts\n';

test('a playlist whose first segment serves media is up', async () => {
  const { impl, calls } = stub({
    'https://x.test/live.m3u8': { body: PLAYLIST_BODY, contentType: PLAYLIST },
    'https://x.test/seg1.ts': { status: 206, body: MEDIA_BODY, contentType: MEDIA },
  });
  const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'up');
  assert.equal(outcome.reason, 'ok');
  assert.equal(typeof outcome.ms, 'number');
  // The segment must actually be requested — a playlist that responds is not evidence.
  assert.deepEqual(
    calls.map((call) => call.url),
    ['https://x.test/live.m3u8', 'https://x.test/seg1.ts'],
  );
  assert.equal(calls[1]?.ranged, true, 'segment fetch should be a ranged GET');
  assert.equal(calls[0]?.hasSignal, true, 'every request needs a timeout signal');
});

test('a live window that slid away under the probe does not sink the stream', async () => {
  // The real-world case: a live playlist's head segment had already rotated out by
  // the time the probe reached it, while a segment further into the window is fine.
  const playlist = [
    '#EXTM3U',
    '#EXT-X-MEDIA-SEQUENCE:2130',
    '#EXT-X-TARGETDURATION:8',
    '#EXTINF:8.0,',
    'old.ts',
    '#EXTINF:8.0,',
    'mid.ts',
    '#EXTINF:8.0,',
    'newer.ts',
    '#EXTINF:8.0,',
    'newest.ts',
  ].join('\n');
  const { impl, calls } = stub({
    'https://x.test/live.m3u8': { body: playlist, contentType: PLAYLIST },
    'https://x.test/old.ts': { status: 404 },
    'https://x.test/newer.ts': { status: 404 },
    'https://x.test/newest.ts': { status: 404 },
    'https://x.test/mid.ts': { status: 206, body: MEDIA_BODY, contentType: MEDIA },
  });
  const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'up', 'a slid window must not read as a dead stream');
  assert.ok(calls.length > 2, 'more than one segment is tried');
});

test('a live stream is only down when every candidate segment is gone', async () => {
  const playlist = ['#EXTM3U', '#EXTINF:8.0,', 'a.ts', '#EXTINF:8.0,', 'b.ts'].join('\n');
  const { impl } = stub({
    'https://x.test/live.m3u8': { body: playlist, contentType: PLAYLIST },
    'https://x.test/a.ts': { status: 404 },
    'https://x.test/b.ts': { status: 404 },
  });
  const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'down');
  assert.equal(outcome.reason, 'segment_failed');
});

test('a refusal on one segment stops the walk', async () => {
  const segments = ['a.ts', 'b.ts', 'c.ts'];
  const playlist = ['#EXTM3U', ...segments.flatMap((name) => ['#EXTINF:8.0,', name])].join('\n');
  // The first candidate is sampled from inside the window, not the head, so the
  // refusal is placed on whatever the sampler actually tries first.
  const [first] = candidateSegments(segments.map((name) => `https://x.test/${name}`), true);
  const routes: Record<string, Route> = {
    'https://x.test/live.m3u8': { body: playlist, contentType: PLAYLIST },
  };
  for (const name of segments) {
    routes[`https://x.test/${name}`] = { status: 206, body: MEDIA_BODY };
  }
  if (first !== undefined) {
    routes[first] = { status: 403 };
  }
  const { impl, calls } = stub(routes);
  const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'blocked');
  assert.equal(calls.length, 2, 'must not keep requesting after a 403');
});

test('the real failure mode: playlist responds 200, first segment is 404', async () => {
  // This is the sampled stream that made a naive reachability check useless.
  const { impl } = stub({
    'https://jmp2.uk/live.m3u8': { body: PLAYLIST_BODY, contentType: PLAYLIST },
    'https://jmp2.uk/seg1.ts': { status: 404, body: 'Not Found' },
  });
  const outcome = await probeStream('https://jmp2.uk/live.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'down');
  assert.equal(outcome.reason, 'segment_failed');
});

test('a master whose first rendition is gone tries the next one', async () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000',
    'low.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000',
    'high.m3u8',
  ].join('\n');
  const { impl } = stub({
    'https://x.test/master.m3u8': { body: master, contentType: PLAYLIST },
    'https://x.test/low.m3u8': { status: 404 },
    'https://x.test/high.m3u8': { body: PLAYLIST_BODY, contentType: PLAYLIST },
    'https://x.test/seg1.ts': { status: 206, body: MEDIA_BODY, contentType: MEDIA },
  });
  const outcome = await probeStream('https://x.test/master.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'up');
});

test('a master whose every rendition is gone is down', async () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n';
  const { impl } = stub({
    'https://x.test/master.m3u8': { body: master, contentType: PLAYLIST },
    'https://x.test/low.m3u8': { status: 410 },
  });
  const outcome = await probeStream('https://x.test/master.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'down');
  assert.equal(outcome.reason, 'variant_failed');
});

test('an fMP4 rendition with a dead init segment is down', async () => {
  const fmp4 = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.0,\nseg1.m4s\n';
  const { impl } = stub({
    'https://x.test/v.m3u8': { body: fmp4, contentType: PLAYLIST },
    'https://x.test/init.mp4': { status: 404 },
    'https://x.test/seg1.m4s': { status: 206, body: MEDIA_BODY },
  });
  const outcome = await probeStream('https://x.test/v.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'down');
  assert.equal(outcome.reason, 'segment_failed');
});

test('an HTML error page is down even behind a 200', async () => {
  const { impl } = stub({
    'https://x.test/live.m3u8': { body: '<html><body>blocked</body></html>', contentType: PLAYLIST },
  });
  const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'down');
  assert.equal(outcome.reason, 'html_body');
});

test('a segment that returns an HTML page is not media', async () => {
  const { impl } = stub({
    'https://x.test/live.m3u8': { body: PLAYLIST_BODY, contentType: PLAYLIST },
    'https://x.test/seg1.ts': { status: 200, body: '<!DOCTYPE html><html></html>', contentType: MEDIA },
  });
  const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'down');
  assert.equal(outcome.reason, 'segment_not_media');
});

test('a URL that responds but is not a playlist is down', async () => {
  const { impl } = stub({
    'https://x.test/live.m3u8': { body: '{"error":"nope"}', contentType: PLAYLIST },
  });
  const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'down');
  assert.equal(outcome.reason, 'not_a_playlist');
});

test('a playlist with no segments is down', async () => {
  const { impl } = stub({
    'https://x.test/live.m3u8': { body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n', contentType: PLAYLIST },
  });
  const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'down');
  assert.equal(outcome.reason, 'empty_playlist');
});

test('a non-HLS 200 with media bytes is up', async () => {
  const { impl, calls } = stub({
    'https://x.test/movie.mp4': { body: MEDIA_BODY, contentType: 'video/mp4' },
  });
  const outcome = await probeStream('https://x.test/movie.mp4', {}, deps(impl));
  assert.equal(outcome.state, 'up');
  assert.equal(calls.length, 1, 'a progressive stream needs no second request');
});

test('declared user agent and referrer are sent', async () => {
  const { impl, calls } = stub({
    'https://x.test/live.m3u8': { body: PLAYLIST_BODY, contentType: PLAYLIST },
    'https://x.test/seg1.ts': { status: 206, body: MEDIA_BODY },
  });
  const headers = { 'user-agent': 'Mozilla/5.0 (declared)', referer: 'https://ref.test/' };
  await probeStream('https://x.test/live.m3u8', headers, deps(impl));
  assert.equal(calls[0]?.headers['user-agent'], 'Mozilla/5.0 (declared)');
  assert.equal(calls[0]?.headers.referer, 'https://ref.test/');
  assert.equal(calls[1]?.headers['user-agent'], 'Mozilla/5.0 (declared)');
});

test('no referrer header is sent when the catalogue declares none', async () => {
  const { impl, calls } = stub({
    'https://x.test/live.m3u8': { body: PLAYLIST_BODY, contentType: PLAYLIST },
    'https://x.test/seg1.ts': { status: 206, body: MEDIA_BODY },
  });
  await probeStream('https://x.test/live.m3u8', { 'user-agent': 'probe/1' }, deps(impl));
  assert.equal('referer' in (calls[0]?.headers ?? {}), false);
});

test('403 is blocked, never down', async () => {
  const { impl } = stub({ 'https://x.test/live.m3u8': { status: 403 } });
  const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'blocked');
  assert.equal(outcome.reason, 'http_forbidden');
});

test('429 is blocked and reports itself to the caller', async () => {
  const { impl } = stub({ 'https://x.test/live.m3u8': { status: 429 } });
  let rateLimited = 0;
  const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl, {
    onRateLimit: () => {
      rateLimited += 1;
    },
  }));
  assert.equal(outcome.state, 'blocked');
  assert.equal(rateLimited, 1);
});

test('a 5xx is blocked, not down', async () => {
  const { impl } = stub({ 'https://x.test/live.m3u8': { status: 503 } });
  const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'blocked');
  assert.equal(outcome.reason, 'http_server_error');
});

test('404 and 410 are the only statuses that assert death', async () => {
  for (const status of [404, 410]) {
    const { impl } = stub({ 'https://x.test/live.m3u8': { status } });
    const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl));
    assert.equal(outcome.state, 'down', `status ${status}`);
    assert.equal(outcome.reason, 'http_gone');
  }
});

test('DNS failure is down', async () => {
  const { impl } = stub({ 'https://x.test/live.m3u8': { throws: transportError('ENOTFOUND') } });
  const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'down');
  assert.equal(outcome.reason, 'dns');
});

test('a refused connection is down', async () => {
  const { impl } = stub({ 'https://x.test/live.m3u8': { throws: transportError('ECONNREFUSED') } });
  const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'down');
  assert.equal(outcome.reason, 'connect');
});

test('a timeout is blocked, because a regional CDN looks exactly like this', async () => {
  const { impl } = stub({
    'https://x.test/live.m3u8': { throws: transportError('ETIMEDOUT', 'TimeoutError') },
  });
  const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'blocked');
  assert.equal(outcome.reason, 'timeout');
});

test('a TLS error is blocked', async () => {
  const { impl } = stub({
    'https://x.test/live.m3u8': { throws: transportError('CERT_HAS_EXPIRED') },
  });
  const outcome = await probeStream('https://x.test/live.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'blocked');
  assert.equal(outcome.reason, 'tls');
});

test('a scheme expo-video cannot play is down for this feed', async () => {
  const outcome = await probeStream('rtmp://x.test/live/app', {}, deps(stub({}).impl));
  assert.equal(outcome.state, 'down');
  assert.equal(outcome.reason, 'unsupported_scheme');
});

test('a refusal on one rendition stops the master walk', async () => {
  // Continuing would hammer an origin that has already said no.
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nb.m3u8\n';
  const { impl, calls } = stub({
    'https://x.test/master.m3u8': { body: master, contentType: PLAYLIST },
    'https://x.test/a.m3u8': { status: 403 },
    'https://x.test/b.m3u8': { body: PLAYLIST_BODY, contentType: PLAYLIST },
  });
  const outcome = await probeStream('https://x.test/master.m3u8', {}, deps(impl));
  assert.equal(outcome.state, 'blocked');
  assert.equal(calls.length, 2, 'must not keep requesting after a 403');
});
