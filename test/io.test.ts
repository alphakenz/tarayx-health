import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadState } from '../src/io.ts';
import type { StateFile } from '../src/types.ts';

const STATE_URL = 'https://example.test/health-state.json';

function respondWith(status: number, body?: string): typeof fetch {
  return (async () => new Response(body ?? '', { status })) as unknown as typeof fetch;
}

function withStateUrl<T>(url: string | undefined, work: () => Promise<T>): Promise<T> {
  const previous = process.env.STATE_URL;
  if (url === undefined) {
    delete process.env.STATE_URL;
  } else {
    process.env.STATE_URL = url;
  }
  return work().finally(() => {
    if (previous === undefined) {
      delete process.env.STATE_URL;
    } else {
      process.env.STATE_URL = previous;
    }
  });
}

test('an unset STATE_URL is a first run', async () => {
  const state = await withStateUrl(undefined, () => loadState(respondWith(500)));
  assert.deepEqual(state, { version: 1, streams: {} });
});

test('a 404 is a first run, not a failure', async () => {
  // This is the state of the world before the very first publish, so it must not
  // block the sweep — the feed legitimately has no history yet.
  const state = await withStateUrl(STATE_URL, () => loadState(respondWith(404)));
  assert.deepEqual(state, { version: 1, streams: {} });
});

test('a 410 is also treated as absent', async () => {
  const state = await withStateUrl(STATE_URL, () => loadState(respondWith(410)));
  assert.deepEqual(state, { version: 1, streams: {} });
});

test('a 500 is fatal, because falling back would zero every down streak', async () => {
  await assert.rejects(
    withStateUrl(STATE_URL, () => loadState(respondWith(500))),
    /state read failed with 500/,
  );
});

test('a network error is fatal', async () => {
  const boom = (async () => {
    throw new Error('ENETDOWN');
  }) as unknown as typeof fetch;
  await assert.rejects(withStateUrl(STATE_URL, () => loadState(boom)), /state read failed: ENETDOWN/);
});

test('a valid document is read through', async () => {
  const published: StateFile = { version: 1, streams: { abc: { s: 'd', d: 2, a: 1 } } };
  const state = await withStateUrl(STATE_URL, () =>
    loadState(respondWith(200, JSON.stringify(published))),
  );
  assert.deepEqual(state, published);
});

test('a document of the wrong shape is rejected rather than half-read', async () => {
  for (const body of ['{"version":2,"streams":{}}', '{"streams":{}}', '[]', 'null', '{}']) {
    await assert.rejects(
      withStateUrl(STATE_URL, () => loadState(respondWith(200, body))),
      /unrecognised document/,
      `body ${body}`,
    );
  }
});
