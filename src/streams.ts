import type { StreamRow } from './types.ts';

/** iptv-org publishes the raw stream list here; it is the input to every sweep. */
export const STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Any absolute URL, not just `http(s)`.
 *
 * The catalogue carries a handful of `rtmp://`, `rtsp://`, `srt://` and `mmsh://`
 * streams. Filtering them out here would leave `probeStream`'s scheme check dead
 * and their channels permanently `unknown`; passing them through lets the prober
 * record a real verdict, which is `down` because `expo-video` cannot play them.
 */
function isAbsoluteUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Narrows one catalogue row to the fields the prober uses.
 *
 * Returns null for rows the prober cannot act on, so a malformed entry costs
 * nothing downstream instead of becoming a probe that always fails and poisons a
 * channel's verdict.
 */
export function normalizeRow(value: unknown): StreamRow | null {
  if (!isRecord(value)) {
    return null;
  }
  const url = value.url;
  if (!isAbsoluteUrl(url)) {
    return null;
  }
  return {
    channel: optionalString(value.channel),
    title: optionalString(value.title) ?? url,
    url,
    referrer: optionalString(value.referrer),
    user_agent: optionalString(value.user_agent),
    quality: optionalString(value.quality),
  };
}

/**
 * Normalises the whole catalogue and drops duplicate URLs.
 *
 * The list contains repeats, and probing a URL twice buys nothing: it would cost
 * a second request against the host and count twice toward the channel rollup. The
 * first occurrence wins, which is arbitrary but stable, and the URL itself is
 * what identifies a stream.
 */
export function normalizeCatalog(input: unknown): StreamRow[] {
  if (!Array.isArray(input)) {
    throw new TypeError('streams.json is not an array');
  }
  const seen = new Set<string>();
  const rows: StreamRow[] = [];
  for (const raw of input) {
    const row = normalizeRow(raw);
    if (row === null || seen.has(row.url)) {
      continue;
    }
    seen.add(row.url);
    rows.push(row);
  }
  return rows;
}

export async function fetchCatalog(
  fetchImpl: typeof fetch = fetch,
  url: string = STREAMS_URL,
): Promise<StreamRow[]> {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`streams.json fetch failed with ${response.status}`);
  }
  return normalizeCatalog(await response.json());
}
