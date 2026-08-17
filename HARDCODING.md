# Hardcoding audit — mechanism vs. policy

> North star: **tools carry MECHANISM** (verified world access), **the MODEL carries POLICY**
> (decisions, thresholds-as-judgment, action selection). Every hardcoded decision in a tool is a
> decision the model can never override, reconsider, or explain.
>
> Classes: **(a) mechanism** — legitimately fixed · **(b) tunable** — belongs in one typed
> `src/config.ts` with env override + documented default · **(c) policy-in-code** — a decision that
> belongs to the model's reasoning.

Audited at `660895a` (2026-08-18). Sweep covered all of `src/` + `src/tools/` + `src/web/`.

---

## (a) Mechanism — leave fixed (documented so nobody "fixes" them later)

| where | what | why it stays |
|---|---|---|
| `sentinel.ts` creeper/TNT hearing | ~1.5s creeper fuse, ~4s TNT fuse in note text | game physics, not policy |
| `reflexes.ts` tick cadence (`REFLEX_TICK_MS` default 300ms) | spinal-cord sampling rate | safety-critical, user-approved: body dodge must not wait on a model round-trip; already env-overridable |
| `helpers.ts` `CREEPER_POINT_BLANK = 3.5` | creeper blast trigger radius | game constant (explosion arm range) |
| `helpers.ts` `CARRIED_EXTRA_SLOTS`, `ARMOR_SLOTS` | protocol slot indices | wire protocol |
| `chatrail.ts` `LEGACY_CHAT` regex, `MAX_CHAT_CHARS = 400` | server chat format / vanilla kick limit (256 hard, 400 split point) | protocol |
| `craft-verify.ts` `VERIFY_WINDOW_MS`/`RESYNC_WINDOW_MS` (1.5s/2s) | server round-trip windows for the 1.21.5+ stateId desync heal | measured protocol latency, not judgment |
| `body.ts` `RECONNECT_DELAY_MS = 3s`, `MAX_ATTEMPTS = 10` | reconnect backoff | infrastructure (borderline (b); low value to expose) |
| `loopwatch.ts` `KEEPALIVE_RISK_MS = 5s`, `LAG_NOTICE_MS = 1s` | event-loop stall → server kick threshold | protocol (server kicks at ~30s keep-alive silence; 5s is the measured danger line) |
| `legs.ts` `LEGS_PRIORITY` ladder | who may yank the pathfinder | arbitration invariant — the fix for issue #22/#34; reordering it in prose would reintroduce flee-vs-attack fights |
| `session.ts` trim/fold machinery, `journeys` `[JOURNEY_DONE]`/`[WAITING:]` sentinels | protocol between runner and model | wire format |
| `web/auth.ts` HMAC compare, cookie shape | security | never model-facing |

## (b) Tunable — move to `src/config.ts` (typed, env-overridable, one-line "why this default")

Already env-overridable but **scattered** (each file rolls its own `process.env` parse — collect
them into config.ts too so there is ONE registry): `SESSION_WINDOW`, `THINKER_INTERVAL_MS`,
`THROTTLE_RETRY_MS`, `REFLEX_TICK_MS`, `REFLEX_COOLDOWN_MS`, `RADAR_MIN_GAP_MS`, `RADAR_REARM_MS`,
`SECURITY_QUIET_MS`, `SECURITY_SETTLE_MS`, `SENTINEL_TIME_POLL_MS`, `TOOL_BREAK_SETTLE_MS`,
`HUNGER_NOTE_AT`, `NOTES_CAP`, `NOTES_TTL_MS`, `WEB_FRAME_MS`, `WEB_PORT`, `VIEWER_PORT`,
`CAMERA_SETTLE_MS`, `TRUSTED_PLAYERS`, disable flags.

New knobs (hardcoded today, no env):

- [x] `journeys.ts:23-39` — `MAX_ITERATIONS = 500`, `MAX_WALL_MS = 2h`, `COOLDOWN_MS = 3s`,
      `YIELD_MAX_MS = 60s`, `MAX_CONSECUTIVE_WAITS = 6`, `WAIT_COOLDOWN_MS = 15s`, `KEEP = 10`
- [x] `fleet.ts:37-40,80` — `MAX_STEPS = 60`, `MAX_WALL_MS = 30min`, `COOLDOWN_MS = 2s`, `KEEP = 20`
- [x] `thinker.ts:32` — `DEFAULT_INTERVAL_MS = 90s` (env exists; default belongs in config)
- [x] `sentinel.ts:471-477` — `RADAR_POLL_MS = 1s`, `RADAR_RANGE = 16`, `SECURITY_RANGE = 24`,
      `OXYGEN_REFLEX_AT = 6`
- [x] `voicebridge.ts:48-54` — `STALE_MS = 5min`, `QUEUE_CAP = 120`, `FLUSH_INTERVAL_MS = 60s`
- [x] `web.ts:33` — `FEED_CAP = 300`
- [x] `reflexes.ts:228,264` — `UNSTUCK_AFTER_MS = 20s`, `CREEPER_EPISODE_MS = 90s`
      (trigger *timing* stays reflex-owned per user direction; the values still deserve knobs)
- [x] `reflexes.ts:122` — flee pathfinder timeout `8_000` (and the 2.5s fight-back window at :187)
- [x] `helpers.ts:405` — torch `COVER = 5` radius; `darknessSurvey` radius 24 / `maxSpots` 600 — VERDICT: keep. check_darkness already exposes radius= (clamped 24); the clamp, maxSpots and COVER are the issue-#4 event-loop-starvation guards + light-math, protection/mechanism not judgment
- [x] `tools/actions.ts` — "within 16 blocks" search radius repeated for bed/enchanting
      table/anvil; attack chase give-up "escaped beyond 24 blocks" (became tool params, not env)

## (c) Policy-in-code — move the decision to the model

Patterns to apply: **return FACTS not verdicts** · **fixed parameters → tool parameters with sane
defaults** · **collapse near-duplicate tools only when the merged schema stays simple**.

### c1. Prescriptive reflex/sentinel notes (one remedy hardcoded in a sentence)

- [x] `sentinel.ts:519` creeper hiss: "SPRINT away … NOW (12+ blocks), everything else can wait"
      — fact is `creeper primed at P, you are D blocks away, blast radius ~7`. Model picks sprint
      /pillar/shield/water. Keep urgency marker; drop the single prescribed remedy + magic 12.
- [x] `sentinel.ts:523` TNT: same shape ("Get 10+ blocks away NOW").
- [x] `sentinel.ts:603` hostile_close: "Fight (attack_entity until='dead') or flee NOW; do not let
      it swing first" — prescribes the two options AND the tool call. Facts: name, distance,
      heading, your hp/weapon. The model knows what attack_entity is (it's in TURN_ECONOMY).
- [x] `sentinel.ts:762` drowning note prescribes "jump + forward toward shore, or dig up" — facts:
      oxygen, depth, shore direction (we already compute `shoreDirection`).
- [x] `reflexes.ts:367` "need a bucket, a door out, or a boat NOW" — the tool enumerates remedies;
      report the trap facts instead.

### c2. Fixed magnitudes inside reflex actions (body may act, but sizes are judgment)

- [x] `reflexes.ts:318` `escape(here, 6)`, `:387` `flee(here, 2)`, `:408` `escape(from, 20,
      allowFight)` — the *trigger* is mechanism; the *distances* are policy frozen at three call
      sites. Config-level defaults + note text that reports what was tried so the model can order
      a different magnitude (a `move`/`go_to` it already owns) when the default keeps failing.
- [x] `helpers.ts` `escapeLadder` rung table (20 blocks/tolerance 2 → 8-block hop → fight 2.5s):
      degradation *order* is mechanism (proven under fire), but rung sizes belong in config and
      the escalation note should state the ladder it ran, not just "NO escape worked".

### c3. Tools that refuse/choose on the model's behalf

- [x] `tools/actions.ts:94` attack_entity gives up at hardcoded 24 blocks → `giveUpRange` param
      (default 24).
- [x] `tools/actions.ts` bed/enchanting/anvil "within 16 blocks" → `range` param (default 16).
- [x] `tools/inventory.ts:157` craft_item error text prescribes "walk to one and retry" — fine as
      advice, but ensure it names *facts* (nearest table coords if any) not just an order.
- [x] `journeys.ts` `MAX_CONSECUTIVE_WAITS = 6` doom rule — the runner decides "waiting is
      futile" for the model. Keep a cap (runaway guard) but surface the count in the step prompt
      so the model can conclude/abandon *before* the guillotine.

### c4. Prompt rules that hardcode strategy (`agent.ts`, `fleet.ts`, `thinker.ts`)

- [x] `agent.ts` SYSTEM_PROMPT: (reviewed — world-facts/protocol/owner-values only, kept) mostly world-facts/protocol (good). Review line-by-line; e.g.
      "retry sensibly before giving up" is fine; "Never toss your tools or armor unless
      explicitly asked" is an owner rule (keep — it's a value, not a strategy).
- [x] `thinker.ts` IDLE_FOCI[3] Progression: hardcodes the tech tree ("no tools → wooden → stone
      → iron…") — the model knows Minecraft's tech tree; keep the *curriculum rule* (one novel
      verifiable task, honor ledgers), drop the walkthrough.
- [x] `thinker.ts` SURVIVAL_OVERRIDE: keep the two world-facts the model demonstrably got wrong
      live (regen needs food ≥ 18; beds don't heal) + "feed yourself now"; slim the remedy list
      (hunt/berries/chest/fish is derivable).
- [x] `fleet.ts` WORKER_PROMPT: (reviewed — discipline rules, no strategy leakage, kept) "Stay near your task site unless the task itself moves" — fine
      (discipline). Review for strategy leakage when touched.

### c5. Tool-family merge candidates (54 tools — merge ONLY if the schema stays simple)

- [x] `use_held_item` / `use_item_on_block` / `use_item_on_entity` → one `use_item`
      (optional `on: {block|entity}` target). Same verb, one packet family; three names force the
      model to pick a variant before it thinks about the act.
- [x] `write_sign` / `write_book` → **kept separate** (different protocols, different
      failure modes) — decide when read closely.
- [x] `creative_inventory` / `creative_fly` → kept: gamemode-gated, self-describing.
- [x] `equip_item` / `unequip` → **kept separate**: unequip's desync read-back contract (armor still worn after the click) is its own semantics; a flag would bury it. Only if schema stays
      one-liner.
- [x] `remember_place`/`recall_places`/`forget_place` → kept: memory CRUD is clearer as verbs.
- [x] `go_to` / `go_to_entity` / `follow_entity` → DONE @ddf9de0: go_to takes entity=; follow_entity kept (persistent goal + legs claim = different contract). (movement.ts:121
      "Provide x,y,z or entity") — verify; if so, `go_to_entity` may be redundant.

---

## Work log

- [x] Iteration 1: this audit.
- [x] Iteration 2: `src/config.ts` + replace (b) call sites (no behavior change at defaults).
- [x] Iterations 3+: c1 → c2 → c3 → c4 → c5 — all shipped, see log below.


---

## Closing log (loop l20260818050913006, 2026-08-18)

| commit | change |
|---|---|
| `28e97a1` | c1: magic numbers → `src/config.ts` (cfg.reflex/sentinel/journey/session), every knob env-overridable with a why-doc |
| `7dfd3e4` | sentinel notes carry FACTS not orders (creeper/TNT/hostile/drowning/poison/ghast) |
| `d097c93` | c3: attack_entity `giveUpRange`, bed/enchant/anvil `range` — frozen ranges became tool params |
| `ddc5340` | c2: escape magnitudes → cfg.reflex; ladder budgets derive from the ONE flee clock |
| `0c4a0a1` | c4: foci are topics not scripts — tech-tree walkthrough out, curriculum rule stays |
| `1912d4c` | c5: use_held_item + use_item_on_block + use_item_on_entity → ONE use_item (54→53… tools) |
| `ddf9de0` | c5: go_to_entity folds into go_to (→51 tools) |
| `8cfb919` | c3: craft_item no-table error names the nearest table; journey prompts show the wait budget |

Rules that emerged, for the next audit:
1. **Mechanism vs judgment** — game facts (melee reach 4.5, light math, protocol sizes)
   stay in code; tradeoffs (how far to flee, when to give up) go to config or tool params.
2. **A note states the fact, the model chooses the remedy.** Every prescriptive string is
   a decision frozen at OUR level of play.
3. **Merge tools when only the TARGET differs; keep them separate when the CONTRACT
   differs** (follow_entity outlives its call; unequip has a read-back guarantee).
4. **Budgets are visible before they are spent** (wait streak, giveUpRange named in the
   give-up report) — self-correction needs the knob's name in the failure.
