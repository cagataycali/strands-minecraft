# AGENTS.md

Guide for AI coding agents working in **strands-minecraft** — a Minecraft bot
where every bot *is* a [Strands](https://github.com/strands-agents) agent and
the full mineflayer surface is exposed as tools. ~18k lines of TypeScript,
74 test files, runs through `tsx` (no build step to run).

Human docs live in `README.md` (features + how to play). This file is the
map for *changing the code*.

---

## Run it

**Docker — the whole rig (server + bot + dashboard):**
```bash
cp .env.example .env         # model creds (AWS_* for Bedrock, or OPENAI_API_KEY)
docker compose up -d         # itzg minecraft server + bot; dashboard on :3008
docker attach strands-bot    # the you> prompt (detach: ctrl-p ctrl-q)
docker compose logs -f bot   # or just watch it think
docker compose up -d --build # rebuild after code changes
docker compose down          # stop the rig
```
An OOM'd or kicked bot restarts itself (`restart: unless-stopped`). World,
passkeys and waypoints live on volumes and survive rebuilds.

**Point at an existing server** instead of the bundled one: set `MC_HOST` in
`.env` (`host.docker.internal` reaches the host Mac/PC), then
`docker compose up -d --no-deps bot`.

**Bare metal** (required for voice — mic/speakers don't cross containers):
```bash
npm install
cp .env.example .env          # + set MC_HOST / MC_PORT
npm start                     # tsx src/index.ts — bot joins, you> prompt opens
```
Node ≥ 22.

**⚠️ Docker VM memory** — the failure mode of this project. Ceilings layer on
purpose: V8 heap cap (`BOT_HEAP_MB=2048`) < container `mem_limit` (3g) < real
VM memory. The Docker VM defaults to ~4GB, which the 2G server JVM + 3G bot
already overspend → the kernel OOM-killer arrives before V8 can GC. Give the VM
**≥6GB** (one bot) / **≥8GB** (fleet or a 2nd bot): `docker info | grep -i memory`,
`colima stop && colima start --memory 8`. Can't grow it? Lower `BOT_MEM_LIMIT`
+ `BOT_HEAP_MB` (keep heap ≈⅔ of the limit) + `MC_MEMORY` together. The bot
prints `🚨 memory ceiling is fiction` at boot when the numbers don't hold
(`src/memcheck.ts`, issue #13).

---

## Develop

```bash
npm test                 # tsx --test test/*.test.ts  (74 files)
npm run typecheck        # tsc --noEmit  +  tsc --noEmit -p tsconfig.test.json
npm run dev              # tsx watch — restarts on save
```
- **No build step to run** — `tsx` executes TypeScript directly; `npm run build`
  (`tsc`) exists but the app and Docker both run via `tsx`.
- **Import extensions are `.js`** even for `.ts` files (ESM/NodeNext). Match it.
- **`type: module`** — ESM only.
- Run `npm test` **and** `npm run typecheck` before proposing a change; tests
  can't run inside the container image (it ships `src`, not `test`) — run them
  on the host.

---

## Architecture — the rails

Everything funnels through **one shared `Session`** (`src/session.ts`):
concurrent requests **fork** the history and **fold** back, so no rail ever
waits on another. `src/index.ts` (`main()`) wires the rails together — read it
first; it is the spine.

| Rail | File | What |
|---|---|---|
| Body | `body.ts` | mineflayer connection as a **proxy** that survives signed-chat kicks (mineflayer#3838); tools built once keep working across reconnects. `onRevive` / `onGaveUp`. |
| Agent | `agent.ts` | builds the Strands `Agent` + `forkFactory`; mounts all tools. Takes a `model` from `model.ts` (`STRANDS_MODEL_PROVIDER` bedrock · openai · anthropic — resolved ONCE in `main()`, shared with every worker). |
| Session | `session.ts` | shared history, fork/fold, sliding-window trim, throttle retry, history audit for split toolUse/toolResult pairs. |
| Tools | `tools/*.ts` | 60 tools = 100% of mineflayer (count generated into docs/numbers.json, pinned by test/readme-numbers.test.ts). `tools/index.ts` `allTools(bot)`. Split by domain: movement, world, inventory, perception, vision, memory, actions, blueprints, craft-verify. |
| Journeys | `journeys.ts` | long goals ("mine until 64 iron") — a loop of model turns with `[JOURNEY_DONE]`/`[WAITING:]` sentinels. |
| Fleet | `fleet.ts` | `manage_bots` — the bot hires its own worker bots (own body + agent), supervised/dismissed by the boss. |
| Thinker | `thinker.ts` | idle reflection every 90s. |
| Sentinel | `sentinel.ts` | event-driven senses: hostile radar (1s poll), day/night, base security around waypoints, vitals. Emits notes + reflexes. |
| Reflexes | `reflexes.ts` | LLM-free spinal cord on a 300ms tick (lava/dying/creeper/stuck). `index.ts` also has pain/hunger reflexes off mineflayer events. |
| Legs | `legs.ts` | pathfinder arbitration lock (`LEGS_PRIORITY`) — the fix for flee-vs-attack fights (#22/#34). Same lock shared by tools + reflexes. |
| Notes | `notes.ts` | `NoteQueue` — capped/aged/subject-collapsed system notes that ride in FRONT of the next turn (never pushed into a mid-turn history). |
| Voice | `voice.ts`, `voicecall.ts`, `voicebridge.ts`, `realtime/*` | push-to-talk (Whisper) + realtime speech⇄speech (CLI and dashboard share `createVoiceCall`). |
| Web | `web.ts`, `web/*` | dashboard: first-person video + full inner-life feed + composer + `/voice` WS; passkey auth (`web/auth.ts`). Ports 3008 (dashboard) + 3007 (viewer). |
| Config | `config.ts` | **every tunable in one registry** with env override + a "why this default". |
| Memcheck | `memcheck.ts` | boot-time memory-ceiling audit + a runtime probe that names the growing structure (issue #44). |

---

## Conventions & hard-won rules (don't relearn these the expensive way)

- **`src/config.ts` is the ONLY home for tunables.** See `HARDCODING.md` for
  the doctrine: tools carry **mechanism** (verified world access), the **model**
  carries **policy** (decisions/thresholds). Three classes: (a) mechanism —
  fixed, documented so nobody "fixes" it; (b) tunable — `config.ts` with env +
  default; (c) policy — belongs in a tool param or the prompt, not a constant.
  Don't add a bare `const THRESHOLD = …` in a rail; route it through `cfg`.
- **Notes never push into a live history.** A death/reconnect/worker note goes
  on the `NoteQueue` and rides in front of the *next* request — pushing into a
  possibly-mid-turn history can split a `toolUse` from its `toolResult` and make
  the provider 4xx.
- **Chat comes off `messagestr`, not `chat`.** `bot.on('chat')` is a regex over
  everything and makes server feedback (`[Cagatay: Teleported…]`) wear a
  player's name and buy a turn. `messagestr` keeps packet position + sender uuid
  — see `chatrail.ts` `classifyMessage`.
- **Peer bots are logged, never answered.** `PEER_BOTS` env stops the bot↔bot
  chat cascade that burns the shared Bedrock quota. Multiple agents on one
  server share one TPM budget — calm idle thinkers (`THINKER_DISABLED`,
  `THINKER_INTERVAL_MS`) before raising anything.
- **A rail that never prints its number is indistinguishable from a broken
  one.** This repo's recurring lesson (see recent commits): make computed
  budgets/prices/decisions *say themselves* (boot log or feed) so a bug is
  visible in a log line, not a silent misbehaviour. Audit-and-announce over
  silent-thinning.
- **Every long-lived collection registers its size** in the memory probe
  (`memoryProbe.track(...)` in `index.ts`) — a leak should name the structure
  that grows, not just prove something did.
- **Corpse guard:** when the body gives up reconnecting, `onGaveUp` shuts every
  rail down and `process.exit(1)` so a supervisor brings a *fresh* process —
  never keep "living" against a dead proxy.

---

## Issue tracking

Findings go to GitHub issues on `cagataycali/strands-minecraft`. Reference the
issue number in the code comment where the fix lives (the codebase is heavily
cross-referenced this way — `grep "#44"` finds the whole story of a fix).

## Layout
```
src/
├── index.ts        wiring: the rails, reflexes, CLI — read first, it is the spine
├── model.ts        STRANDS_MODEL_PROVIDER → one Model for the primary and every worker
├── agent.ts        Strands Agent + fork factory; mounts the tools
├── session.ts      fork/fold shared history, throttle retry, pair audit
├── body.ts         reconnect proxy — the body that heals
├── legs.ts         pathfinder arbitration lock (tools · reflexes · journeys)
├── reflexes.ts     300 ms LLM-free spinal cord
├── sentinel.ts     event-driven senses → edge-triggered notes
├── notes.ts        NoteQueue — notes ride in front of the next turn, never mid-turn
├── digest.ts       the ≤8-line status block before every self-prompt
├── thinker.ts      idle mind / journey supervisor
├── journeys.ts     long-goal background loops (persisted)
├── fleet.ts        worker bots (hire / instruct / dismiss)
├── chatrail.ts     game chat classification (messagestr, not chat)
├── loopwatch.ts    runaway-loop detection
├── memcheck.ts     boot memory audit + runtime census
├── history-doctor.ts  repairs split toolUse/toolResult pairs
├── config.ts       every tunable, one registry, env override + why
├── voice*.ts, realtime/   push-to-talk, realtime call, voice bridge
├── web.ts, web/    dashboard (MJPEG/SSE/say), passkey auth, tiny endpoint
└── tools/          60 game tools by domain
test/               74 node:test files (fake world + fake bot)
docs/               landing page + numbers.json + findings/
```
