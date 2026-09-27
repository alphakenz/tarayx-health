import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHtmlLike, looksLikePlaylist, readCapped } from '../src/http.ts';
import { candidateSegments, firstVariant, parsePlaylist } from '../src/playlist.ts';

test('rejects a body that is not a playlist', () => {
  assert.equal(parsePlaylist('<html>404</html>', 'https://x.test/a.m3u8').kind, 'invalid');
  assert.equal(parsePlaylist('', 'https://x.test/a.m3u8').kind, 'invalid');
  assert.equal(parsePlaylist('{"error":"nope"}', 'https://x.test/a.m3u8').kind, 'invalid');
  // Leading whitespace is tolerated, since real playlists are sometimes padded.
  assert.equal(parsePlaylist('\n  #EXTM3U\n#EXTINF:-1,\na.ts', 'https://x.test/dir/a.m3u8').kind, 'media');
});

test('a BOM ahead of the tag is tolerated rather than called dead', () => {
  // Some origins emit a UTF-8 BOM. A strict parser would mark a working stream
  // dead, and a wrong `down` can retire a channel, so the BOM is stripped.
  const playlist = parsePlaylist('﻿#EXTM3U\n#EXTINF:-1,\na.ts', 'https://x.test/a.m3u8');
  assert.equal(playlist.kind, 'media');
  assert.equal(playlist.kind === 'media' ? playlist.segments[0] : null, 'https://x.test/a.ts');
});

test('extracts segments from a rendition playlist', () => {
  const playlist = parsePlaylist(
    ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.0,', 'seg1.ts', '#EXTINF:6.0,', 'seg2.ts'].join('\n'),
    'https://x.test/live/index.m3u8',
  );
  assert.equal(playlist.kind, 'media');
  if (playlist.kind !== 'media') {
    return;
  }
  assert.deepEqual(playlist.segments, [
    'https://x.test/live/seg1.ts',
    'https://x.test/live/seg2.ts',
  ]);
  assert.equal(playlist.init, null);
});

test('resolves relative segment URIs against the playlist', () => {
  const playlist = parsePlaylist('#EXTM3U\n#EXTINF:6.0,\nseg1.ts', 'https://x.test/a/b/index.m3u8');
  assert.equal(playlist.kind === 'media' ? playlist.segments[0] : null, 'https://x.test/a/b/seg1.ts');
});

test('extracts the fMP4 init segment from EXT-X-MAP', () => {
  const playlist = parsePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:4.0,',
      'seg1.m4s',
    ].join('\n'),
    'https://x.test/live/index.m3u8',
  );
  assert.equal(playlist.kind === 'media' ? playlist.init : null, 'https://x.test/live/init.mp4');
});

test('treats a multivariant playlist as a master and keeps its renditions', () => {
  const playlist = parsePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
      'high/index.m3u8',
    ].join('\n'),
    'https://x.test/master.m3u8',
  );
  assert.equal(playlist.kind, 'master');
  if (playlist.kind !== 'master') {
    return;
  }
  assert.deepEqual(playlist.variants, [
    'https://x.test/low/index.m3u8',
    'https://x.test/high/index.m3u8',
  ]);
  assert.equal(firstVariant(playlist), 'https://x.test/low/index.m3u8');
});

test('an EXT-X-MEDIA tag makes a playlist a master even with a rendition below', () => {
  const playlist = parsePlaylist(
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"\n#EXTINF:6.0,\nseg1.ts',
    'https://x.test/live/index.m3u8',
  );
  assert.equal(playlist.kind, 'master');
});

test('EXT-X-MEDIA-SEQUENCE does not make a live rendition a master', () => {
  // The bug this guards: prefix-matching `#EXT-X-MEDIA` also matched
  // `#EXT-X-MEDIA-SEQUENCE`, which appears in nearly every live stream and is a
  // media-playlist tag. Doing so made the prober walk segments as if they were
  // variant playlists and call healthy streams dead.
  const playlist = parsePlaylist(
    [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-MEDIA-SEQUENCE:2130',
      '#EXT-X-DISCONTINUITY-SEQUENCE:0',
      '#EXT-X-TARGETDURATION:8',
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXTINF:8.00000000,',
      'stream02125.ts?uid=2990118473',
    ].join('\n'),
    'http://x.test/live/v.m3u8',
  );
  assert.equal(playlist.kind, 'media');
  assert.equal(playlist.kind === 'media' ? playlist.segments[0] : null, 'http://x.test/live/stream02125.ts?uid=2990118473');
});

test('a master with no renditions is empty, not valid', () => {
  const playlist = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1', 'https://x.test/master.m3u8');
  assert.equal(playlist.kind, 'master');
  assert.deepEqual(playlist.kind === 'master' ? playlist.variants : null, []);
  assert.equal(firstVariant(playlist), null);
});

test('a single unresolvable URI line does not sink the whole parse', () => {
  // One malformed line must not turn a working playlist into a dead channel, so
  // the bad entry is dropped and the good segments still drive the verdict.
  const playlist = parsePlaylist(
    '#EXTM3U\n#EXTINF:6.0,\nhttp://[\n#EXTINF:6.0,\nseg2.ts',
    'https://x.test/live/index.m3u8',
  );
  assert.equal(playlist.kind, 'media');
  assert.equal(playlist.kind === 'media' ? playlist.segments.length : -1, 1);
  assert.equal(playlist.kind === 'media' ? playlist.segments[0] : null, 'https://x.test/live/seg2.ts');
});

test('a rendition without ENDLIST is live, and one with it is complete', () => {
  const live = parsePlaylist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:2130\n#EXTINF:8.0,\na.ts', 'https://x.test/v.m3u8');
  const complete = parsePlaylist('#EXTM3U\n#EXTINF:8.0,\na.ts\n#EXT-X-ENDLIST', 'https://x.test/v.m3u8');
  assert.equal(live.kind === 'media' ? live.live : null, true);
  assert.equal(complete.kind === 'media' ? complete.live : null, false);
});

test('live candidates avoid the sliding window edge', () => {
  // The head of a live playlist is the oldest entry and rotates away, so a probe
  // that fetches it is racing the encoder. Candidates must come from inside.
  const segments = Array.from({ length: 20 }, (_unused, index) => `seg${index}.ts`);
  const live = candidateSegments(segments, true);
  assert.ok(live.length >= 3, 'several candidates are tried');
  assert.equal(live.includes('seg0.ts'), true, 'the head is a last resort, not the first choice');
  assert.equal(live[0], 'seg13.ts', 'starts well inside the window');
  assert.equal(new Set(live).size, live.length, 'candidates are distinct');
});

test('a short live window still yields a usable candidate', () => {
  assert.deepEqual(candidateSegments(['a.ts', 'b.ts'], true), ['b.ts', 'a.ts']);
  assert.deepEqual(candidateSegments(['only.ts'], true), ['only.ts']);
  assert.deepEqual(candidateSegments([], true), []);
  assert.deepEqual(candidateSegments([], false), []);
});

test('a complete rendition prefers its head, which cannot rotate', () => {
  const segments = Array.from({ length: 20 }, (_unused, index) => `seg${index}.ts`);
  const complete = candidateSegments(segments, false);
  assert.equal(complete[0], 'seg0.ts');
});

test('detects an HTML error page served with a media content type', () => {
  // The failure this guards: a 200 whose body is an HTML page, with a lying
  // content type, which a naive reachability check scores as healthy.
  const bytes = new TextEncoder().encode('  <!DOCTYPE html><html><head></head></html>');
  assert.equal(isHtmlLike('application/vnd.apple.mpegurl', bytes), true);
  assert.equal(isHtmlLike(null, bytes), true);
  assert.equal(isHtmlLike(null, new TextEncoder().encode('<HTML>')), true);
});

test('does not mistake a media segment for HTML', () => {
  const ts = new Uint8Array([0x47, 0x40, 0x00, 0x10]);
  assert.equal(isHtmlLike('video/mp2t', ts), false);
  // Ad-marker preambles and ID3 tags are real and must not be rejected.
  assert.equal(isHtmlLike('video/mp2t', new TextEncoder().encode('##XT')), false);
  assert.equal(isHtmlLike('audio/mpeg', new TextEncoder().encode('ID3')), false);
});

test('recognises a playlist served where a segment was expected', () => {
  assert.equal(looksLikePlaylist(new TextEncoder().encode('#EXTM3U\n')), true);
  assert.equal(looksLikePlaylist(new Uint8Array([0x47, 0x40])), false);
});

test('readCapped stops at the cap and cancels the rest', async () => {
  const chunk = new Uint8Array(1024).fill(65);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // An unbounded live segment: 100 chunks, of which only 4 may be read.
      for (let index = 0; index < 100; index += 1) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  const response = new Response(stream);
  const bytes = await readCapped(response, 4096);
  assert.equal(bytes.length, 4096);
  assert.equal(bytes[0], 65);
  assert.equal(bytes[4095], 65);
});

test('readCapped returns a short body whole', async () => {
  const bytes = await readCapped(new Response(new Uint8Array([1, 2, 3])), 4096);
  assert.deepEqual([...bytes], [1, 2, 3]);
});
