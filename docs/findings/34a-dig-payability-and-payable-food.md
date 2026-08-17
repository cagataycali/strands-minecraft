# The dig nobody could afford, and the remedy nobody could buy

Two live gaps from `/tmp/mc-soak43.log` (a ~20-minute soak on the #34 tip, 0
deaths), plus a third the same log had been hiding. Both of the first two were
exposed *by* #34's fixes: once the grading stopped lying, what it graded turned
out to be impossible.

```
bdb4b72  #34/A  a dig has a price and the lungs have a budget: 187.5s of stone against 2.3s of air
daaf27b  #34/B  a remedy that needs an item the bag cannot buy is not a remedy: payability leads
91d8e3b  #34/A2 a body cannot escape a danger nobody reports: suffocation is a hazard with a paid remedy
94e95dd  #34/A  a rail that never prints its number is indistinguishable from a broken one
90bccad  #34/A  the live print caught what 754 tests could not: a dig names the block where it actually is
```

## A — the dig was never payable, at any tool tier

soak43, verbatim:

```
[self_preservation] EVACUATING water at 3/20 air, 18 hp — swam 1.2m upward
against stone at y=42 — no shore within 16 and no open column within 8:
STILL SUBMERGED — head underwater 1.2m later (attempt 1), and UP IS SEALED:
stone at y=41 is the ceiling, so swimming up cannot surface this body
→ could not dig the stone overhead: dig timeout
```

Everything before the arrow is `6a6f624` working perfectly. Everything after it
was a fantasy: `bot.dig` raced against a **flat 5s timeout** with whatever was
already in the hand.

A probe against the game's own pricer (`probe-digprice.mjs`, prismarine-block on
1.21.4) prices stone for a body that is underwater and NOT standing on ground:

| hand | dry | underwater + off ground |
|---|---|---|
| bare fist | 7.50s | **187.50s** |
| wooden pickaxe | 1.15s | 28.15s |
| stone pickaxe | 0.60s | 14.10s |
| iron pickaxe | 0.40s | 9.40s |

A **full** air bar is 15s. soak43 had 3 bubbles — 2.3s. So that dig was
unpayable at *every* tier, and the ×5 underwater and ×5 off-ground multipliers
are the whole reason. The old code could not know this because it never asked
what the dig cost; it asked only whether 5 seconds had passed.

Shipped mechanism (`digPlan` / `airBudgetMs` / `bestDigTool`, one `payDig()` in
the reflex):

- **the dig has a price** — every hand in the bag is priced with
  `block.digTime(itemType, false, inWater, notOnGround)`, penalties included,
  and the cheapest one wins (a tie keeps the hand already held: no pointless
  swap costs a tick);
- **the lungs have a budget** — air left (`AIR_MS_PER_UNIT` 750ms per bubble)
  plus the drowning the body can survive down to `DIG_HP_RESERVE` (4 hp, so a
  hit or a fall is still survivable when it surfaces);
- **the cheapest hand is EQUIPPED before the first swing**, and the legs are
  released first, because movement cancels digging and the evacuation swim
  leaves `forward`+`jump` held;
- **the timeout is the price, not a constant** — `min(budget, price × 1.5 + 1s)`.
  A flat 5s was simultaneously too long for three bubbles and too short for
  stone;
- **an unpayable dig is refused OUT LOUD** and the seconds buy something else:
  `swim_lateral` if a real open column is in reach, else `pillar` if the bag
  holds anything placeable, else the mind is handed the second with the price
  attached. A refusal that names its number is a fact; silence is a death.

## A2 — the wall that killed a body no reflex could see

The same log, line 87: `StrandsBot suffocated in a wall`. Four lines earlier:

```
[dying] health 5/20 after a 1-damage hit — standing down instead of escaping:
no hostile in sight and no hazard underfoot — the damage is coming from the
world (hunger, suffocation, a fall), and no direction is safer than another
```

It *named suffocation as a suspect and then held still*, because suffocation was
not a hazard anything reported: `standingHazards` only ever asked "is the block
at head height water", and rock is not water. `gradeEvacuation` did grade a
sealed head as SUFFOCATING → `dig_up` (that is `1a99f01`), but that verdict only
runs **inside the water evacuation** — a dry head inside rock reached nothing at
all.

So `head_in_block` is now a standing hazard, with solidity read from the game's
`boundingBox` and never from a name list — `1a99f01`'s trap, re-pinned by a test:
head-high `tall_grass` must produce **no** hazard, or the body digs its way out
of a meadow. Its remedy is the same `payDig`, which out of the water loses both
×5 penalties: 7.5s of bare-handed stone against a full 15s bar, nearly always
payable.

**LESSON: a body cannot escape a danger nobody reports.** The reflex that was
closest to the death had already deduced the cause and had no hazard to act on.

## B — the remedy named a price the bag could not pay

soak43, at 1.3 hp:

```
[starving] STARVING with nothing edible in the bag — Food 16/20; health
regenerates only at 18+, so I am 2 short of healing at all. At 1.3 hp the
SAFEST remedy wins, not the best one. FISH would be safest (water 8 blocks
away at (-39,62,1)) but the rod is unpayable: MISSING 3 more sticks and 2 more
string (kill a spider)
```

Every number is true. `a4adf63` had already made the distance honest. And then
the mind held perfectly still for **ten consecutive journey steps** and whispered
to the human for a food drop — because the route the remedy LED with was the one
route the body could not take, and the cheapest route it *could* take was never
named.

The weapon rail had solved this shape already and nobody noticed: soak43 also
contains `NEAREST WEAPON: a wooden_sword costs 2 planks + 1 stick … but a placed
spruce_planks block is 8 blocks away at (-26, 71, 15): mining it returns the
plank itself`. That is a remedy priced against what the world can actually give.
Hunger had the arithmetic and not the ranking.

Shipped: every food route carries **payable now or not**, and payability
outranks safety and distance.

- an unpayable route can only ever be a footnote: `FISH (water 8 blocks away …)
  — NOT UNTIL I have 3 more sticks and 2 more string`;
- if nothing is payable the lead is TRAVEL, and the sentence says so instead of
  ranking fantasies;
- **rotten flesh in the bag is now the leading payable route**, not a trailing
  aside on a "nothing to do" verdict: poison costs hp, but it is the only meal
  that needs no errand at all;
- a passive animal beats an unpayable rod, and says why — `a chase with bare
  fists is enough for it`.

Policy stays with the model: this only refuses to lead with something the bag
cannot buy.

## The print, and what it caught

`94e95dd` makes the pricer say itself once at boot — soak38's lesson, that a rail
which computes without logging is indistinguishable from a broken one. The first
live print, soak46:

```
[dig_budget] the stone underfoot at y=59, if this body ever has to dig out
through it: PAYABLE: digging the stone OVERHEAD costs 7.5s with a bare fist
and I can pay 15.0s — 15.0s of air left and NO drowning to spend (1.3 hp is at
or under the 4 hp reserve)
```

Two things at once. The pricing is real — 7.5s bare-handed dry stone is exactly
the probe's number, from the live registry in the live process, and the budget
correctly refuses to spend drowning seconds it does not have at 1.3 hp. And the
sentence **contradicts itself in nine words**: `underfoot` … `overhead`, because
two rails each chose a noun. That is `2bda086`'s stutter again in a new place, it
survived 754 green tests, and the live print is what found it (`90bccad`: the
caller names the place, `digPlan` repeats it).

**LESSON: the number a rail computes must appear in a log line, and the line must
be read at least once — the disagreement was invisible in every unit test because
each test knew only its own half of the sentence.**
