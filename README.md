# tarayx-health

Probes the public [iptv-org](https://github.com/iptv-org/iptv) stream list and
publishes a per-channel availability feed that [Tarayx TV](../tarayx-tv) uses to
hide channels that are not actually watchable.

No server, no database, no cost. Two GitHub Actions jobs probe the catalogue
every two hours and publish `health.json` to GitHub Pages.

## Why a plain reachability check does not work

The obvious implementation — "does the stream URL return 200?" — reports dead
streams as healthy often enough to be useless. During development a sampled
stream returned a well-formed `#EXTM3U` with HTTP 200, and the first variant in
that playlist 404'd. Roughly one in six streams in the catalogue is in that state.

So a stream only counts as `up` once a real media byte has been read:

```
GET playlist  →  is it HTML?  →  master or rendition?
                                  ├─ master  → try up to 3 renditions
                                  └─ media   → #EXT-X-MAP init segment, then first segment
                                                          each a ranged GET of 64 KB
```

`HEAD` is not used: several origins answer `HEAD` correctly and `GET` wrongly, so
it produces false positives.

### Two traps found by probing real streams

Unit tests with a stubbed `fetch` all passed while both of these were live bugs.
They are recorded here because both worked in the same direction: a healthy stream
reported as dead, which over time retires channels that play perfectly well.

**The live window slides under the probe.** A live playlist is a sliding window —
its first entry is the oldest segment still listed, and it disappears as the
window advances. One sampled stream's first segment returned `200`; the identical
request `404`'d two minutes later purely because the window had moved. Reading the
head of a live playlist and then fetching it is a race against the encoder. So for
a live rendition, segments are sampled from *inside* the window and several are
tried before the stream is called dead. A complete rendition (`#EXT-X-ENDLIST`)
has no sliding window, so its head is stable.

**`#EXT-X-MEDIA` is a prefix of `#EXT-X-MEDIA-SEQUENCE`.** The latter is a *media*
playlist tag present in nearly every live stream, so a prefix match classified
ordinary live renditions as multivariant indexes. The prober then walked media
segments as though they were variant playlists and called healthy streams dead.
The colon in `#EXT-X-MEDIA:` is load-bearing.

After both fixes, a 60-stream sample moved from 14 up / 4 down to 20 up / 1 down;
the two streams that had been wrongly marked dead were serving media.

## Verdicts

The `down` / `blocked` split is the most important decision in this repository,
because the app hides a channel when every one of its streams is `down`. A `down`
must be positive evidence of death.

| Verdict | Meaning | Examples | Hides a channel? |
| --- | --- | --- | --- |
| `up` | Media bytes were read | `206` of 1,525 bytes | no |
| `down` | The origin says it is not there | NXDOMAIN, refused, `404`, `410`, HTML error page, dead variant or segment | yes, after 2 sweeps |
| `blocked` | We could not get it; says nothing about liveness | `401`, `403`, `429`, any `5xx`, TLS error, timeout | **never** |
| `skipped` | The probe never ran (host rate-limited) | host tripped | never |

`blocked` is the bias that matters. About 7% of the catalogue is geo-restricted,
and a prober running on a US runner sees those as `403` or a timeout. Collapsing
them into "dead" would hide channels that play perfectly for a viewer in another
country — the worst thing this feed could do.

A stream is only retired after `min_down_streak` **consecutive** failed sweeps
(2 by default). Any `up` resets the streak immediately; `blocked` and `skipped`
leave it untouched, since neither is evidence.

At the channel level:

- **online** — at least one stream is `up`
- **dead** — every stream has a full down streak
- **unknown** — anything in between, including a single `blocked` stream

The app fails open on `unknown`, on a missing channel, and on a feed that is
stale, malformed, or unreachable.

## Politeness

These are hosts this project does not pay for, so:

- one request at a time per host
- 500 ms minimum gap between requests to the same host
- a host that answers `429` three times is dropped for the rest of the sweep
- a `429` carrying `Retry-After` is skipped until the window the server named, taken at
  face value rather than counting strikes. `Retry-After: 0`, a negative or non-numeric
  value, and the HTTP-date form all fall back to the strike counter; a delay beyond an
  hour is capped there, since a sweep is minutes long and no sweep can outlast it
- at most 40 streams per host per sweep
- `User-Agent` and `Referer` are sent **as the catalogue declares them** — 789 rows
  declare a user agent and 324 a referrer, and ignoring them turns working streams
  into `403`s

## Sampling

Re-probing 17,600 streams every two hours would be rude and would buy almost
nothing. The schedule is tiered by what is currently believed:

| Previous verdict | Re-probed when |
| --- | --- |
| never probed | always |
| `down` | every sweep — this is what advances the streak |
| `up` | once stale (6 h) **and** in a deterministic 20% sample |
| `blocked` | same 20% sample, since a 403 is not going to change between sweeps |
| `skipped` | always, since being skipped produced no evidence |

The sample comes from a hash of the URL rather than a random draw, so rerunning a
shard makes the same choice and shards never disagree about who owns a stream.

## Layout

```
src/
  probe.ts       the ladder, and the verdict mapping
  playlist.ts    pure HLS parsing (master / rendition / EXT-X-MAP)
  http.ts        capped body reads, HTML and playlist detection
  plan.ts        which streams this shard sweeps
  host-budget.ts per-host serialisation, spacing, 429 circuit breaker, Retry-After
  rollup.ts      down-streak reduction and channel rollup
  streams.ts     catalogue fetch and normalisation
  probe-shard.ts one shard's entrypoint
  merge.ts       the only job that writes state and publishes
   test/            83 tests, node:test

```

## Design notes

- **No dependencies.** Node 24 runs the TypeScript directly via type stripping, so
  there is no build step and nothing to install but the type checker.
- **Staleness is safe, wrongness is not.** A missing or failed shard leaves those
  streams on their previous verdicts, because `reduceState` only folds in records
  it was given. A partial sweep is stale; the app fails open on age.
- **The merge only tolerates a state that is genuinely absent.** A `404` is the
  expected answer before the first publish and starts from empty. Any other read
  failure is fatal: falling back to empty would zero every down streak and
  republish those zeros as fresh evidence, which can retire live channels. Stale
  state is safe, absent-because-broken state is not.
- **`down` requires proof.** Non-HLS schemes like `rtmp://` are marked `down`
  because `expo-video` cannot play them either, so for this feed that is genuine
  evidence rather than a regional unknown.

## Local use

```sh
npm install
npm test
npm run typecheck

# Probe a slice locally. No STATE_URL means a first run from an empty state, and a
# 404 on the configured URL means the same. Set STATE_URL to carry streaks forward.
OUT_DIR=out MAX_PROBES=200 node src/probe-shard.ts
OUT_DIR=out node src/merge.ts
```

`merge.ts` writes `public/health.json` and `public/health-state.json`.

## Deployment

The `health-sweep` workflow probes in four shards every two hours, then merges and
publishes the `public` directory through GitHub Pages, so the feed is served at
`https://alphakenz.github.io/tarayx-health/health.json`. The merge step reads the
previous state from the same site with a run-id query string appended, because Pages
is CDN-backed and a cached copy of the state would silently rewind every streak.

The app fetches that URL at a **lowest** download priority, so it never competes
with the 3.65 MB `streams.json` the catalogue is actually built from.
