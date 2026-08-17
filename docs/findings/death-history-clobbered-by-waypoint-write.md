# A writer that only knows its own key deletes the rest (#35)

**Found:** 2026-08-18, WEDGE + REPEAT-DEATH loop #2, from the live store — not from a test.

## The symptom the supervisor handed me

soak37: 20 deaths / 137 `hurt by` episodes / 137 fight bursts in **17 minutes**
(14.6 deaths per 100 episodes vs 9.7 in the best armed soak), **zero** repeat-death
facts in the log — even though three deaths landed at the *identical* block
`(-12, 64, 4)` (log lines 418, 451, 483) and four more sat inside 6 blocks of each
other. The brief's hypothesis was that a grave was an exact-coordinate match and a
real spiral wanders.

## The hypothesis was wrong, and the log said so

`cfg.deaths.sameSiteRadius = 6` already made a grave a REGION (loop #1, f0b5ab8), and
the soak37 coordinates were well inside it:

| pair | distance |
|---|---|
| (-12,64,4) x3 | 0 |
| (-10,64,4) → (-12,64,4) | 2.0 |
| (-15,67,15) → (-15,68,18) | 3.2 |
| (-25,66,11) → (-27,68,7) | 4.9 |
| (-21,68,14) → (-25,66,11) | 5.4 |

So the arithmetic would have fired. The evidence that it *couldn't* was not in the
log at all — it was in `~/.strands-minecraft/memory.json`, which after 20 deaths held
exactly one key:

```
keys [ 'places' ]   deaths 0
```

## Root cause

`src/index.ts:448` runs, on every death:

```ts
const site = p ? recordDeath(p, …) : undefined;      // appends to store.deaths
writePlace('last_death', p, …);                      // the VERY NEXT LINE
```

and `writePlace` → `save(places)` wrote `JSON.stringify({ places })`. Waypoints were
served perfectly and `deaths` was **deleted microseconds after every death was
written**. Each death then read an empty history, so `deathSiteRepeat` correctly
returned `undefined` and `deathSiteFact` correctly returned `''`. Every death was the
first death forever. The mind's `remember_place` tool erased the history too.

## Fix (ccf64b7)

`readStore()` / `patchStore(patch)`: every writer merges into whatever is on disk.
`save()` and `recordDeath()` both go through it. Test `soak37 replayed: the waypoint
write must not erase the death history` reproduces the handler's exact two-line
sequence and asserts the 3rd death of a wandering spiral is announced as the 3rd.

## The class this belongs to

Same family as #48 (a resolved mineflayer promise is not evidence the world changed):
**the write succeeded and the fact it destroyed was invisible.** A rail that reads its
own store back — the discipline loop #1 added on purpose — cannot save you when a
sibling writer truncates the file to the part it understands.

Generalisation worth a sweep: any `writeFileSync(file, JSON.stringify({ oneKey }))`
in a file shared by two rails is this bug. `journeys.json` and `fleet.json` are the
next places to look.

## Live proof, same day

Bot restarted on the tip (pid 78540, /tmp/mc-soak38.log). First death at
`(-14, 58, 20)`, followed by the same `writePlace('last_death')` call, and the store
now reads:

```
keys [ 'places', 'deaths' ]   deaths 1
```

which is one more than 20 deaths produced before the fix.
