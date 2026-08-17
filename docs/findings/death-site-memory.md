# A grave is a place: death-site memory (#35)

## The evidence

`/tmp/mc-soak36.log` — four deaths in one session:

```
💀 died at 1, 67, 30
💀 died at 1, 67, 30
💀 died at 1, 67, 30
💀 died at -2, 66, 30
```

Three at one coordinate, the fourth five blocks away — one room. All four
announcements to the mind were the SAME sentence, ending "think about what
killed you before walking into it again". The mind was asked to think about a
history it had no record of.

## Why the history did not exist

The death handler saved the spot as the waypoint `last_death`, and
`writePlace()` REPLACES a name. So each death overwrote the proof that the
previous one had happened in the same room. The store had exactly one death in
it at all times, by construction.

## The fix

- `deathSiteRepeat(history, latest, {radius, windowMs})` — pure: is this death a
  repeat of a PLACE? 6-block cell (`cfg.deaths.sameSiteRadius`), 45-minute
  window, dimension-aware (same coordinates in the Nether are not the same
  grave), centred on the death that STARTED the cluster.
- `deathSiteFact(repeat)` — the sentence, and it carries a CONSEQUENCE rather
  than a count (the #46 fist-arithmetic rule): "3rd death within 6 blocks of
  (1, 67, 30) in 12 min … A life at this spot has been lasting ~6 min. The gear
  from 2 earlier deaths here has already despawned (drops last ~5 min), so a
  corpse-run recovers one life's worth at most." Returns `''` for a first death:
  silence is the honest report when there is no repeat.
- `recordDeath()` in `src/tools/memory.ts` appends to a `deaths` list in the same
  JSON file and then READS THE FILE BACK before counting — the number the mind
  gets is the store's, not this process's intent (#48's false-green rule).
- `get_status` gains a `deathSites` field ONLY when some place has killed us
  more than once. A field that is always present is a field that is never read
  (that is precisely how `heldItem: 'empty hand'` failed for a whole night).

Policy stays with the model: the note names the place, the rate and the loss,
then says "what changes (armour first, a different approach, sealing it off, or
writing the spot off) is your call".

## Known gap / follow-up

The server's death MESSAGE ("was shot by a skeleton") is not captured yet —
`DeathRecord.cause` and the fact sentence already support it, but nothing feeds
it, because mineflayer delivers it on the message rail and not on `death`. A
cause per grave would turn "3 deaths here" into "3 deaths here, all to
skeletons", which is a different decision. It is deliberately absent rather than
guessed.

## Proof: the live soak36 log replayed through the rail

Timing taken from the log itself — memcheck probes land every 30s
(`cfg.memcheck.probeIntervalMs`), so counting the `🧮` lines before each `💀`
line gives that death a real clock (±30s). No intervals were invented.

```
death 1  @ +24m (1,67,30)    -> (no repeat — silent, as designed)
death 2  @ +25m (1,67,30)    -> 2nd death within 6 blocks of (1, 67, 30) in 30s …
death 3  @ +25m (1,67,30)    -> 3rd death within 6 blocks of (1, 67, 30) in 30s …
death 4  @ +25m (-2,66,30)   -> 4th death within 6 blocks of (1, 67, 30) in 60s …
death 5  @ +43m (-20,66,14)  -> (no repeat)
death 6  @ +44m (-21,67,15)  -> 2nd death within 6 blocks of (-20, 66, 14) …
death 7  @ +45m (-19,69,22)  -> (no repeat)
death 8  @ +45m (-17,68,20)  -> 2nd death within 6 blocks of (-19, 69, 22) …
death 9  @ +45m (-14,68,22)  -> 3rd death within 6 blocks of (-19, 69, 22) …
death 10 @ +46m (-24,67,17)  -> 3rd death within 6 blocks of (-20, 66, 14) in 3 min …
death 11 @ +46m (0,64,0)     -> (no repeat)
death 12 @ +47m (-13,63,6)   -> (no repeat)
death 13 @ +48m (-35,65,8)   -> (no repeat)
```

**Before:** 13 deaths, 13 identical announcements, 0 mentions of a repeat.
**After:** the same 13 deaths produce 7 repeat announcements at THREE graves —
and 6 silences, because a first death at a place is not news about a place.

The replay also caught a bug the unit tests had not modelled: deaths 2 and 3
share a coordinate AND a 30s clock bucket, and `recordDeath` was identifying the
row it had just appended BY VALUE — so it deleted the earlier death as "me" and
announced the third as the second. The appended row is identified by POSITION
now (`test/death-site.test.ts`, last case). An identity another row can satisfy
is not an identity — the same lesson as the wedge in #35's first half.
