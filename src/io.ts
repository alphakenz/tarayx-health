import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StateFile } from './types.ts';

/** JSON and state-file I/O shared by both entrypoints. */

/** Identity sent when the catalogue declares no user agent for a stream. */
export const PROBER_USER_AGENT =
  'TarayxHealth/1.0 (+https://github.com/alphakenz/tarayx-health)';

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Every knob is an env var so a workflow run is reproducible without a rebuild. */
export const settings = {
  shard: envNumber('SHARD', 0),
  shardCount: envNumber('SHARD_COUNT', 1),
  minDownStreak: envNumber('MIN_DOWN_STREAK', 2),
  upFreshMs: envNumber('UP_FRESH_MS', 6 * 60 * 60 * 1000),
  upSamplePercent: envNumber('UP_SAMPLE_PERCENT', 20),
  downRevisitMs: envNumber('DOWN_REVISIT_MS', 2 * 60 * 60 * 1000),
  maxProbes: envNumber('MAX_PROBES', 12_000),
  maxPerHost: envNumber('MAX_PER_HOST', 40),
  requestTimeoutMs: envNumber('REQUEST_TIMEOUT_MS', 10_000),
  segmentCapBytes: envNumber('SEGMENT_CAP_BYTES', 64 * 1024),
  maxVariants: envNumber('MAX_VARIANTS', 3),
  maxSegmentAttempts: envNumber('MAX_SEGMENT_ATTEMPTS', 4),
  minSpacingMs: envNumber('MIN_SPACING_MS', 500),
  concurrentHosts: envNumber('CONCURRENT_HOSTS', 32),
  userAgent: process.env.PROBER_USER_AGENT ?? PROBER_USER_AGENT,
};

export function outDir(): string {
  return process.env.OUT_DIR ?? 'out';
}

/**
 * Directory that is actually deployed.
 *
 * Kept separate from `outDir` so the per-shard records — which are large,
 * intermediate, and of no use to the app — can never be published by accident.
 */
export function publicDir(): string {
  return process.env.PUBLIC_DIR ?? 'public';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function looksLikeState(value: unknown): value is StateFile {
  return isRecord(value) && value.version === 1 && isRecord(value.streams);
}

/**
 * Loads the carried-over state from the published Pages URL.
 *
 * A `404` is the expected answer before the first publish, not a fault: it means
 * there is no history yet, and the correct response to "no history" is to start
 * with an empty state. Every other failure is fatal. Falling back to empty on a
 * `500` or a network error would reset every down streak to zero and re-probe the
 * whole catalogue, and the merge step that follows would publish those resets as
 * though they were fresh evidence — which can retire live channels. Stale state is
 * safe; absent-because-broken state is not.
 *
 * An unset `STATE_URL` is treated the same as a `404`: an explicit first run.
 */
export async function loadState(fetchImpl: typeof fetch = fetch): Promise<StateFile> {
  const url = process.env.STATE_URL;
  if (url === undefined || url === '') {
    return { version: 1, streams: {} };
  }
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new Error(`state read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404 || response.status === 410) {
    process.stderr.write('state read returned 404; starting from an empty state (first run)\n');
    return { version: 1, streams: {} };
  }
  if (!response.ok) {
    throw new Error(`state read failed with ${response.status}`);
  }
  const parsed: unknown = await response.json();
  if (!looksLikeState(parsed)) {
    throw new Error('state read returned an unrecognised document');
  }
  return parsed;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function listFiles(dir: string, prefix: string): Promise<string[]> {
  const entries = await readdir(dir).catch((): string[] => []);
  return entries.filter((name) => name.startsWith(prefix) && name.endsWith('.json')).sort();
}
