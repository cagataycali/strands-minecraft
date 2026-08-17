# #34 — closing comment (paste by hand)

`gh` on this machine is **not authenticated** (`gh auth status` → "You are not
logged into any GitHub hosts"), so the loop could not comment or close. Paste
the body below into issue #34 and close it. Everything in it is verified against
the tip and against `/tmp/mc-soak43.log` (a ~20-minute live soak, 0 deaths).

---

**Closed by 8 commits across two loops** — `5984feb`, `a2bfc1b`, `3322922`,
`2bda086`, `685373b`, `6a6f624`, `a4adf63`, `4b8bf9d`. Evidence doc:
`docs/findings/34-escape-failure-and-starvation-deadlock.md`. 736/736 tests green.

This was one issue and **three stacked bugs** — fixing the top one only exposed
the next:

1. **The grading lied.** soak41 printed sixteen `head is OUT of the water`
   successes while the bot floated in a lake at 0 hp: success was sampled on the
   frame the swim stopped, which is exactly when a swimming head is out.
   → `3322922` grades on ground truth (head clear **and** feet clear **and**
   something solid underfoot), read after a settle window, and a failure
   escalates to a different mechanism instead of repeating the same one.
2. **The grading became honest and the escape stayed impossible.** soak42, on
   the tip: `swam 10.0m upward (no shore within 16): STILL SUBMERGED … →
   swimming again on the next tick`. Holding jump under a roof surfaces nobody.
   → `6a6f624` reads the column over the head before spending the legs
   (`waterColumn`: open / blocked / deep / unloaded-guess) plus
   `lateralAirColumn` (the nearest column that *really* reaches air,
   ray-checked), and **a blocked column beats the attempt budget**: next is
   `swim_lateral` or `dig_up` on attempt 1, because repeating an impossible
   direction costs ~5s of drowning damage at 6 hp.
3. **A head inside rock was called a clear head** — found by the live probe, not
   by 733 tests: `headClear` only asked "is it water". → `1a99f01` reads the
   head block's `boundingBox` from the registry (rock is a wall, head-high tall
   grass is not — a name list would have stranded a body on dry land), a sealed
   head grades SUFFOCATING → `dig_up`.

**Starvation half:** the suspected lie (`sweet berry bush 3 blocks away at
(54,71,85)` allegedly read from 90 blocks off) was *not* a lie — soak42 has
`wedge at (53,70,82)` four lines earlier. It was true **by accident**, so
`a4adf63` made it a property: `FoodWorld.at` records where the probe stood and
`foodRemedy` derives the distance from the body's position at *speaking* time,
so the two numbers in the sentence can never disagree.

**Live proof on the tip (soak43, ~20 min, 0 deaths):** the new grading named a
sealed column out loud instead of swimming into it —

```
[self_preservation] EVACUATING water at 3/20 air, 18 hp — swam 1.2m upward
against stone at y=42 — no shore within 16 and no open column within 8:
STILL SUBMERGED … UP IS SEALED: stone at y=41 is the ceiling, so swimming up
cannot surface this body
```

and an evacuation that could work, worked: `EVACUATING water at 0/20 air, 20 hp
— swam 41.2m upward … OUT — on solid ground, head and feet clear of the water`.

**Two follow-ons that the honest grading exposed are tracked separately** (they
are *new* bugs the old lying grade hid, not regressions of this one):

- **dig-out is unpayable:** the same soak43 line ends `→ could not dig the stone
  overhead: dig timeout`. The verdict was right and the remedy failed — the dig
  raced a flat 5s timeout with no tool equipped, and underwater + off-ground dig
  penalties make bare-handed stone impossible inside a 3/20 air budget.
- **the remedy names a price the bag cannot pay:** `FISH would be safest (water
  8 blocks away) but the rod is unpayable: MISSING 3 more sticks and 2 more
  string` — after which the mind held still for ten journey steps at 1.3 hp. The
  arithmetic is honest; the advice is a dead end, because the cheapest remedy it
  *can* pay for is never named.

---

## Both follow-ons are now fixed too (same day, 6 commits)

See `docs/findings/34a-dig-payability-and-payable-food.md`. Short version:

| commit | what |
|---|---|
| `bdb4b72` | **A** — a dig has a price and the lungs have a budget: every hand in the bag priced with the game's own `digTime` (×5 underwater, ×5 off-ground included), cheapest hand EQUIPPED, timeout sized to the price, unpayable refused out loud with a fallback that can actually be bought |
| `daaf27b` | **B** — payability outranks safety and distance in the hunger remedy; an unpayable route can only be a footnote, rotten flesh in the bag leads, and with nothing payable the lead is TRAVEL |
| `91d8e3b` | **A2** — suffocation is a HAZARD (`head_in_block`, solidity from `boundingBox`, never a name list) with the same paid dig: the `dying` reflex had named suffocation as the suspect and stood still, because nothing reported it |
| `94e95dd` | the dig budget prints itself at boot — a rail that never prints its number is indistinguishable from a broken one |
| `90bccad` | the live print's first line said "the stone UNDERFOOT … digging the stone OVERHEAD costs": one namer, one noun |
| `3d51699` | the evidence doc |

Third bug in the same 20-minute log, and the one worth carrying forward: **the
reflex closest to the death had already deduced the cause and had no hazard to
act on.** A body cannot escape a danger nobody reports.
