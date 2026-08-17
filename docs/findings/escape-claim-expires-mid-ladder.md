# The escape lost the legs it had already claimed (issue #34, soak41)

## The line

```
⚡ [dying] health 0/20 after a 2-damage hit — disengaging the area: NO escape worked
  (path 20m (The goal was changed before it could be completed!),
   retrying the same path — cancellation is not a terrain problem,
   path 20m (flee timeout), path 7m (flee timeout), blind sprint (went nowhere))
  — still at (2, 61, -53), hostiles: none visible
```

Four rungs, zero displacement, no hostile. Two independent bugs meet here.

## 1. The claim's time box is SHORTER than the ladder it protects

Arithmetic, straight from source (no world needed):

| rung | budget | source |
|---|---|---|
| `path` far | 8 000 ms | `cfg.reflex.fleeTimeoutMs` |
| retry of the same rung after a cancellation | 8 000 ms | `escapeRetry()` — 1 retry allowed |
| `path` near | 4 000 ms | `fleeTimeoutMs / 2` |
| `blind` | 1 500 ms | `cfg.reflex.blindSprintMs` |
| `fight` | 2 500 ms | `cfg.reflex.fightBackMs` |
| **total** | **24 000 ms** | |

`legsTtlOf({name:'dying'})` returns **15 000 ms**, and the claim is taken ONCE, in
the tick, before the ladder starts. It is never renewed. So on every ladder that
gets past rung two, the escape is running **with no claim at all** — the legs are
formally free while the body is still trying to save its life. Anything of any
rank may then `setGoal` legally, and pathfinder says exactly what happened:
`The goal was changed before it could be completed!`

The comment on `escapeRetry()` says the retry is safe *"because by then the claim
locks every lower rank out"*. That premise is false for precisely the rungs that
need it. The retry re-paths **unprotected**, which is why soak41 shows a
cancellation, a retry, and then two timeouts from a body that never moved.

## 2. The cancellation is never attributed, although the answer is in hand

`LegsLock.explainCancellation(owner)` exists (issues #22/#30) and names the rail
that took the legs, or says `BUG: another rail called setGoal with NO claim`.
The escape ladder never calls it. So the most important diagnostic line in the
log ends at "cancellation is not a terrain problem" — true, and useless.

## 3. Fleeing from nothing

`dying` with no hostile within 16 blocks uses
`from = bot.entity.position.offset(1, 0, 0)`, so `awayFrom()` produces a point 20
blocks along **−x** — an arbitrary compass direction with no relation to the
threat, because the threat was drowning/starvation. "hostiles: none visible" in
the same sentence is the tell: *escape* is the wrong verb when the damage source
is the block you are standing in, or an empty food bar.

## Fix landed for 1 + 2

- `escapeBudgetMs(ladder, retries)` — the ladder prices its own worst case, so a
  claim can be derived from what it protects instead of a magic constant.
- The ladder **renews** the claim before every rung (same owner is re-entrant),
  and if a live claim now belongs to someone else it **stops and says whose it
  is** rather than pathing under them.
- `escapeRetry()` takes `holdsLegs`: a cancellation is only worth retrying while
  we still own the legs. Without them the retry is the bug it was meant to fix.

3 is fixed separately (a standing hazard is evacuated, not fled).
