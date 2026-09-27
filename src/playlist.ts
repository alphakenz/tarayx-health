/**
 * Playlist parsing, kept pure and free of I/O so the part of the prober most
 * likely to be wrong can be tested exhaustively.
 *
 * This exists because a reachability check is not a liveness check. A sampled
 * stream returned `200` with a perfectly valid `#EXTM3U` whose first variant
 * 404'd — a naive "does the URL respond" probe reports that dead stream as
 * healthy, and roughly one in six of the catalogue is in that state. The chain has
 * to be followed to the first real media byte or the verdict means nothing.
 */

export type Playlist =
  | { kind: 'master'; variants: string[] }
  | { kind: 'media'; segments: string[]; init: string | null; live: boolean }
  | { kind: 'invalid' };

/**
 * Tags that make a playlist a multivariant index rather than a rendition list.
 *
 * The colon after `#EXT-X-MEDIA` is load-bearing: without it the prefix also
 * matches `#EXT-X-MEDIA-SEQUENCE`, which is a *media* playlist tag present in
 * nearly every live stream. Matching it loosely classified ordinary live renditions
 * as multivariant indexes, so the prober walked media segments as though they were
 * variant playlists and reported healthy streams as dead.
 */
const MASTER_TAGS = ['#EXT-X-STREAM-INF', '#EXT-X-I-FRAME-STREAM-INF', '#EXT-X-MEDIA:'];

/** `URI="..."` as it appears in `#EXT-X-MAP`, `#EXT-X-MEDIA` and friends. */
const URI_ATTRIBUTE = /URI="([^"]*)"/i;

function isMasterTag(line: string): boolean {
  const upper = line.toUpperCase();
  return MASTER_TAGS.some((tag) => upper.startsWith(tag));
}

/** URI lines are either absolute or relative, and HLS resolves them against the playlist. */
function resolveUri(uri: string, baseUrl: string): string | null {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * Classifies a playlist body and extracts what a liveness probe needs from it.
 *
 * A master playlist yields variant playlists; a rendition playlist yields
 * segments and, for fMP4, the `#EXT-X-MAP` initialisation segment — which must be
 * fetched too, because an fMP4 rendition with a dead init segment is unplayable
 * even when every segment URI looks fine.
 */
export function parsePlaylist(text: string, baseUrl: string): Playlist {
  // A BOM or leading whitespace ahead of the required tag means the body is not a
  // playlist at all, and treating it as one produces a false `up`.
  const body = text.replace(/^﻿/, '').trimStart();
  if (!body.toUpperCase().startsWith('#EXTM3U')) {
    return { kind: 'invalid' };
  }

  const lines = body.split(/\r?\n/);
  const uris: string[] = [];
  let master = false;
  let live = true;
  let init: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      continue;
    }
    if (!line.startsWith('#')) {
      const resolved = resolveUri(line, baseUrl);
      if (resolved) {
        uris.push(resolved);
      }
      continue;
    }
    const upper = line.toUpperCase();
    if (isMasterTag(line)) {
      master = true;
    }
    // `#EXT-X-ENDLIST` marks a complete, non-sliding rendition.
    if (upper.startsWith('#EXT-X-ENDLIST')) {
      live = false;
    }
    if (upper.startsWith('#EXT-X-MAP')) {
      const match = URI_ATTRIBUTE.exec(line);
      if (match?.[1] && init === null) {
        init = resolveUri(match[1], baseUrl);
      }
    }
  }

  if (master) {
    return { kind: 'master', variants: uris };
  }
  return { kind: 'media', segments: uris, init, live };
}

/**
 * Segments worth fetching from a rendition, most stable first.
 *
 * This is the subtlest failure mode in the whole prober. On a live stream the
 * playlist is a *sliding window*: its first entry is the oldest segment still
 * listed, and it disappears as the window advances. Verified against a real
 * stream during development — the first segment returned 200, and the identical
 * request 404'd two minutes later purely because the window had moved on. A prober
 * that reads the head of a live playlist and then fetches it is therefore racing
 * the encoder, and it will report healthy streams as dead often enough to retire
 * live channels.
 *
 * So for a live rendition the candidates are sampled from *inside* the window
 * rather than from its edge, and several are tried before the stream is called
 * dead. A complete rendition has no sliding window, so its head is stable.
 */
export function candidateSegments(segments: readonly string[], live: boolean): string[] {
  if (segments.length === 0) {
    return [];
  }
  const wanted = live ? [0.7, 0.4, 0.9, 0.15, 0] : [0, 0.25, 0.6, 0.9, 1];
  const picks: string[] = [];
  for (const fraction of wanted) {
    const index = Math.min(
      segments.length - 1,
      Math.max(0, Math.round((segments.length - 1) * fraction)),
    );
    const segment = segments[index];
    if (segment !== undefined && !picks.includes(segment)) {
      picks.push(segment);
    }
  }
  return picks;
}

/** A safe rendition to fetch from a master playlist, or null when it has none. */
export function firstVariant(playlist: Playlist): string | null {
  if (playlist.kind !== 'master') {
    return null;
  }
  return playlist.variants[0] ?? null;
}
