# soak47 — NINE deaths where soak46 had zero

Evidence: `/tmp/mc-soak47.log` (1243+ lines, ~40 min, live append). Nine deaths:
seven `StrandsBot was slain by Phantom`, one `suffocated in a wall`, plus three
hard model errors that killed the session outright.

## 1. THE RESERVE DEADLOCK — fixed

Line 89, verbatim:

```
⚡ [self_preservation] SUFFOCATING — head inside sand — SUFFOCATING at (-33, 60, 7), 0 hp:
   could not dig the sand at head height: Digging aborted —
   PAYABLE: digging the sand at head height costs 0.8s with a bare fist and I can pay 15.0s
   — 15.0s of air left and NO drowning to spend (0.3 hp is at or under the 4 hp reserve)
```

**WRONG BELIEF: that an hp reserve applies to a dig at all.** `DIG_HP_RESERVE=4`
was subtracted from the budget unconditionally, so a body at 0.3 hp was told —
inside the sentence that let the dig through — that it had "NO drowning to
spend". Two things were wrong with that:

- **A dig covered by the air bar spends ZERO hp.** 0.8s of sand against 15s of
  air drowns nobody, so the reserve had nothing to protect and no business in
  the sentence. `digHpCost()` now computes what the dig itself will spend: only
  the milliseconds PAST the bubble bar, at 2 hp/s.
- **A reserve that forbids the ONLY exit is the reserve killing the body it
  protects.** With no sideways column and nothing placeable, the dig *is* the
  exit. `digPlan`/`airBudgetMs` now take `soleExit` (defaulted from
  `!lateralExit && !canPillar`): in that case the 4 hp comfort reserve gives way
  to `DIG_SURVIVAL_FLOOR_HP = 0.5`.

Pinned at both ends (`test/dig-payable.test.ts`): the soak's own 0.8s-at-0.3-hp
dig is payable and says "this dig spends NO hp"; 1.5s of drowning (3 hp) at 4 hp
goes ahead *only* when it is the sole exit; 4.0s (8 hp) at 4 hp still refuses;
soak43's 28.1s underwater stone at 3 hp still refuses, now priced honestly as
"would drown 51.8 hp out of the 3.0 hp I hold".

Note the *other* half of line 89, still open: the dig failed with mineflayer's
`Digging aborted` because the body died at 0.3 hp mid-dig. Grading fired far too
late — the head was already sealed and the hp already gone. Tracked as a
follow-on, not fixed by this commit.

## 2. Tool-input JSON kills the session — OPEN (next)

Twice `unable to parse tool input JSON SyntaxError: Expected ',' or '}' after
property value in JSON at position 83`, then
`[session] ModelError kind=unknown retryable=false: unable to parse tool input
JSON`. A malformed tool call from the provider must be a RECOVERABLE turn: feed
the parse failure back as a tool error so the model can re-emit the call.

## 3. Seven phantom deaths — OPEN

`swung 2x at the phantom 2.9-3.0m away with fists x2 (3 pass(es) held while it
hung beyond striking distance) — it is 5.5m away, out of reach`. A phantom
dives, strikes, and climbs out of melee reach: a ground-bound melee reflex can
never resolve the fight, so the body stands there being eaten. Remedy must be
COVER (a 2-high roofed space) graded as its own hazard — "unreachable attacker"
— with flight read from the registry, not a mob-name list.

## 4. Four `note(s) perished unread (older than the 120s usable window)`

Recorded only. Notes are being produced faster than the mind consumes them
during death storms; no fix attempted while the above are open.
