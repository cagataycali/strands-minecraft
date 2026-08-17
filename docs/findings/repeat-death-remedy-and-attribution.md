# A repeat grave has to say what to CHANGE — and must not invent the killer

Issue #35, second half. The first half (`f0b5ab8`, `1fd1227`, `ccf64b7`) made the
rail *exist*: a death site is a place, its identity is a 6-block cell, and the
history stopped being deleted by the waypoint write on the next line.

## What was still wrong

`deathSiteFact` could say "3rd death within 6 blocks of (-10,64,3) in 9 min" and
leave the mind with **nothing to change**. A count is not a remedy — the same
lesson #46 learned when `heldItem: 'empty hand'` sat in `get_status` for a whole
bare-fisted night and changed nothing, because a noun is not a consequence.

## The fix

A death now records its **conditions** at the moment it happens
(`deathContext`, read off the live body):

| field | how it is read | why |
|---|---|---|
| `cause` | the last damage source, if fresher than `cfg.deaths.causeFreshMs` (10s) | mineflayer's `death` event carries **no cause**; the hurt rail's `damage_event` source is the only evidence |
| `armour` | armour pieces counted by **structure** (`isArmorPiece`), not slot index | `b5ca5f2`: slot 5-8 turned a stray spruce log into a claimed helmet |
| `night` | `bot.time.isDay` | a surface spiral after dark is a different problem from a cave one |
| `doing` | the running journey's goal, trimmed | a spiral usually has one job behind it |

`sharedConditions()` then names only what the **whole cluster** agrees on:

> What every one of these deaths had in common: not one armour piece worn; every
> one after dark; all of them underground at y 64; every one during the same job:
> "mine iron at y 60".

**Unanimity is the test, and a missing field abstains without vetoing.** Rows
written before these fields existed say nothing about armour rather than claiming
zero — "we did not look" and "zero worn" must not read the same.

## What the live probe caught

The 3 real soak38 rows at `(-10,64,3)` — written by a bot process that had since
been killed, which is exactly the cross-restart claim #35 is about — were
replayed through the current code. Persistence and repeat detection both held
(`count: 4`, `centre: (-10,64,3)`, prior piles 8/8/9 min old), and the conditions
correctly abstained. But the causes sentence read:

> …every one of them: **zombie**

over **one** attributed death and three that named nothing. The mind would have
been handed an invented cause of death for a place it was deciding about — the
false-green class again (#48), this time inside a fact that was otherwise true.

`DeathSiteRepeat.attributed` now gates the strong sentence (`attributed ===
count`); otherwise the fact states how thin the evidence is: "the one death we
identified of them: zombie (the other 3 named nothing)".

## And: a fact the log never prints is still a silent rail

soak38 detected **three** repeat graves in 13 minutes and the log contained not
one word about any of them — the fact went to the mind and the voice queue only,
so from the outside the fixed rail was indistinguishable from the broken one, and
no soak could be graded. `645e9a7` prints `💀 [grave] …`. Same lesson as
`c90b087` (the bare-handed escalation) and worth stating once as a rule:

> **A rail whose only output is a note is unverifiable. Print the fact you queue.**

## Ops notes earned the hard way

- `npm start`'s **tsx child** holds ports 3007/3008 and does *not* match
  `pgrep -f "tsx src/index.ts"`. Killing only the parent leaves `EADDRINUSE`.
  `lsof` is not on PATH on this Mac: use `/usr/sbin/lsof -nP -iTCP:3008`.
- `.env` carries `MC_HOST=host.docker.internal` — start local soaks with
  `MC_HOST=127.0.0.1`.
