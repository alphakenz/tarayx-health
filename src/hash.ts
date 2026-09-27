import { createHash } from 'node:crypto';

/**
 * Short, stable key for a value.
 *
 * 16 hex chars is 64 bits, so collisions across ~18k streams are not a practical
 * concern, and the short form is what keeps the state document small enough to
 * publish and re-read every two hours.
 */
export function sha1Key(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

/**
 * A deterministic value in [0, 1) for a string.
 *
 * The tiered schedule needs to sample a *subset* of healthy streams each sweep
 * without `Math.random`, because a shard has to make the same decision on a
 * re-run and the shards have to agree on which streams belong to whom. Hashing
 * the URL gives a stable sample with no stored state.
 */
export function hashUnit(value: string): number {
  return parseInt(sha1Key(value).slice(0, 5), 16) / 0x100000;
}

/** Which shard a host belongs to. Hashing the host keeps a host whole in one shard. */
export function shardOf(host: string, shardCount: number): number {
  return parseInt(sha1Key(host).slice(0, 4), 16) % shardCount;
}
