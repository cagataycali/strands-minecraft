# #34 — the escape that never stuck, and the starving body that could not pay

Closed 2026-08-18. Eight commits across two loops, every claim below tied to a
live log line or a live probe against the running world.

```
5984feb  an escape must own the legs for as long as it escapes
a2bfc1b  the verb follows the killer — and hunger names an errand it can pay for
3322922  one frame of air is not an escape: an evacuation is graded on the ground
2bda086  the remedy names the water once, and 0.166 hp is not "0.2"
685373b  a body harness for the bob: the frame that lied, reproduced
6a6f624  up is a direction, not a plan: an evacuation reads the ceiling first
a4adf63  a distance is only true next to the position it was measured from
1a99f01  a head inside rock is suffocating, not treading water
```

## The shape of the bug, in three layers

The issue looked like one bug ("the bot drowns and starves") and was three,
stacked so that fixing the top one only revealed the next:

1. **The grading lied.** soak41 printed sixteen `EVACUATING water … head is OUT
   of the water` successes while the bot floated in a lake at 0 hp, because
   success was "no water over the head" sampled on the frame the swim stopped —
   which is exactly when a swimming body's head is out. → `3322922`: three
   facts (head clear, feet clear, something solid underfoot), read after a
   settle window, and a failure ESCALATES to a different mechanism.
2. **The grading became honest and the escape stayed impossible.** soak42, on
   the tip: `EVACUATING water at 10/20 air, 6 hp — swam 10.0m upward (no shore
   within 16): STILL SUBMERGED — head underwater 10.0m later (attempt 1) →
   swimming again on the next tick`. Ten metres of swimming under a roof,
   graded correctly, answered with "do it again". → `6a6f624`.
3. **A head inside a block was called a clear head.** Found by the live probe,
   not by a test: `headClear` asked "is it water", and rock is not water. →
   `1a99f01`.

## Layer 2 — up is a direction, not a plan

`waterColumn()` reads the column over the head one block at a time:

- `open` — N blocks of water, then air: swimming works, and the distance is a
  number instead of a hope.
- `blocked` — that block, at that y: swimming up **cannot** surface this body.
- `deep` — water past the search: up is right, the distance is unknown (which
  is not the same as zero).
- an unloaded chunk reads as open, and says it was a guess.

`lateralAirColumn()` is the usual remedy under a roof: the nearest column that
actually reaches air, ray-checked for a swimmable path (an air pocket behind
masonry is not an exit — `shoreDirection`'s old lesson) and rejected when its
own column is sealed too.

And the decision changed shape: **a blocked column beats the attempt budget.**
Repeating an impossible direction is not a failed attempt, it is ~5 seconds of
drowning damage (`EVAC_SWIM_MS` 4s + `EVAC_GRACE_MS` 1.2s) at 6 hp. So
`gradeEvacuation` returns `swim_lateral` when there is somewhere to go and
`dig_up` when there is not — on attempt 1.

### Live proof (probe-ceiling.mts, against the running world)

A second empty-handed body joined the same server and ran our own exports over
real blocks:

```
WATER at (-9, 60, 28) dist 13.5
FROM (-9, 60, 28) COLUMN {"kind":"blocked","block":"sandstone","y":61} EXIT undefined
  VERDICT next=dig_up :: NOT OUT — the head is inside sandstone: this body is
  SUFFOCATING in a pocket, not treading water, after 10.0m (attempt 1)
FROM (-9, 59, 28) COLUMN {"kind":"blocked","block":"sandstone","y":61}
  EXIT {"x":-8,"y":59,"z":28,"dist":1,"toAir":4}
  VERDICT next=swim_lateral :: STILL SUBMERGED — head underwater 10.0m later
  (attempt 1), and UP IS SEALED: sandstone at y=61 is the ceiling, so swimming
  up cannot surface this body
```

The second row is soak42's exact situation — submerged, no shore within 16, a
roof overhead — and the answer is now a **one-block swim east** to a column with
four blocks of water to air. A dry body on stone still grades `OUT — on solid
ground` (the negative control), so the new verdicts are not free optimism.

## Layer 3 — the head block, from the registry

`groundTruth` now reads the head block's `boundingBox` (the game's own answer),
so **rock is a wall and head-high tall grass is not** — a name list would have
mistaken grass for a ceiling and stranded a body standing on dry land.
`gradeEvacuation` grades a sealed head as SUFFOCATING and goes to `dig_up`;
`dig_up` digs whichever block is lowest — head height when that is the seal,
else the one above it.

## The starvation half

- `a2bfc1b` — **the verb follows the killer.** soak41 spent four rungs of escape
  fleeing a threat that did not exist. soak43, live: `[dying] health 5/20 after
  a 1-damage hit — standing down instead of escaping: no hostile in sight and no
  hazard underfoot — the damage is coming from the world (hunger, suffocation, a
  fall), and no direction is safer than another`. And when the killer flies:
  `[dying] health 3/20 … the phantom flies, so running is not an escape: swung
  1x at the phantom 0.9m away`.
- `5984feb` — **an escape owns the legs for its whole budget**, so a walk is not
  abandoned one metre in. soak42 line 299 shows the ladder working through three
  cancelled paths and finishing with `blind-sprinted 10m to (-41, 61, -3)`.
- `2bda086` — the remedy names the water once, and `0.166` hp prints as `0.17`,
  not `0.2`: below 1 hp the second decimal is the difference between dying and
  not.
- `a4adf63` — **a distance is only true next to the position it was measured
  from.** The suspected lie (`FORAGE: sweet berry bush 3 blocks away at
  (54,71,85)` while the bot was allegedly 90 blocks off) was NOT a lie: four
  lines earlier soak42 has `wedge at (53, 70, 82)`. It was true by accident —
  there happens to be exactly one producer of a `FoodSighting`. So the property
  was built: `FoodWorld.at` records where the probe stood, `foodRemedy` takes
  the body's position at speaking time and DERIVES every printed distance from
  the coordinate it prints, and a sighting with no coordinate is named
  "12 blocks away as last measured (no coordinate to check it against)".
  soak43, live: `FISH would be safest (water 8 blocks away at (-39,62,1))` from
  a body at (-32.3, 60, 5.8) — √(49+4+16) = 8.3. The two numbers agree because
  one is computed from the other.

## Tests

736 → all green (`npm test`; node:test/TAP — vitest reports a false RED of 61
failures on this repo). New in this pass: `test/water-column.test.ts` (14
cases: open/blocked/deep/unknown columns, the lateral exit and its two refusals,
the budget-beating verdicts, suffocation vs tall grass), `test/food-distance.test.ts`
(7 cases: the feared line reprices to ~92 blocks, the noun stutter in both rod
branches, an unprobed world inventing nothing), and two new BODY cases on the
soak41 bob harness in `test/evacuation.test.ts` — a sealed roof with a shaft
nearby swims sideways, a sealed roof with nowhere to go digs on attempt 1.

## Left on the table

1. **A death cluster that names missing armour has no payable remedy.** The #35
   grave rail keeps saying "not one armour piece worn" and stops there — the
   #47 pattern (name the cost, the holdings, the shortfall AND the distance)
   has never been applied to armour.
2. **The dying rail cancels its own walk.** soak42 line 299: `path 20m (The goal
   was changed before it could be completed! — a newer dying path replaced this
   one (same owner) …)`, three times in one episode. A rail that preempts itself
   burns its budget on re-planning.
