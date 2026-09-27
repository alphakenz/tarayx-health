/**
 * Response reading helpers.
 *
 * A live HLS segment has no content length and never ends, so "read the body"
 * is not an option for the media check. Everything here is capped, and the
 * stream is cancelled once the cap is reached so a segment fetch costs a few
 * kilobytes rather than an unbounded read.
 */

const DEFAULT_CAP = 64 * 1024;

/**
 * Reads at most `cap` bytes, then cancels the underlying stream.
 *
 * Cancelling matters as much as the cap: a live segment would otherwise keep the
 * connection open and the probe would hang until its own timeout.
 */
export async function readCapped(response: Response, cap: number = DEFAULT_CAP): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.length > cap ? buffer.subarray(0, cap) : buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.length > 0) {
        chunks.push(value);
        total += value.length;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  if (chunks.length === 1) {
    const only = chunks[0] as Uint8Array;
    return only.length > cap ? only.subarray(0, cap) : only;
  }
  const joined = new Uint8Array(Math.min(total, cap));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= cap) {
      break;
    }
    const slice = chunk.length > cap - offset ? chunk.subarray(0, cap - offset) : chunk;
    joined.set(slice, offset);
    offset += slice.length;
  }
  return joined;
}

/**
 * Whether a body is an HTML document rather than media.
 *
 * Content type is the fast path, but a `200` error page from a CDN is routinely
 * served as `text/plain` or with no type at all, so the leading bytes are checked
 * as well. The 404 bodies seen in a sampled sweep began `<htm`, which is exactly
 * the case that has to be caught.
 */
export function isHtmlLike(contentType: string | null, bytes: Uint8Array): boolean {
  if (contentType && /text\/html|application\/xhtml/i.test(contentType)) {
    return true;
  }
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 512))
    .replace(/^﻿/, '')
    .trimStart()
    .toLowerCase();
  return /^<(?:!doctype\s+html|html|head|body|meta)\b/.test(head);
}

/** Whether a body is itself a playlist, which means a segment fetch went wrong. */
export function looksLikePlaylist(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 32))
    .replace(/^﻿/, '')
    .trimStart()
    .toUpperCase();
  return head.startsWith('#EXTM3U');
}
