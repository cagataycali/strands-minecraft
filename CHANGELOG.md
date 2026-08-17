# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org).

## [0.1.0] — 2026-09-22

First public release. Three years after the original chat relay
([tinyai-id-minecraft-ai-agent-example](https://github.com/TinyAI-ID/tinyai-id-minecraft-ai-agent-example)),
this is the remaster: the bot is a real [Strands](https://github.com/strands-agents/sdk-typescript)
agent with a body.

### The agent
- **61 tools = 100 % of mineflayer** ([COVERAGE.md](COVERAGE.md)): perception, movement,
  digging (`dig_vein` fells a tree or mines a vein in one call), building (`build_blueprint`,
  parametric `build_structure` with a dry-run material bill), crafting that chains
  intermediates, combat (`attack_entity until:'dead'`), containers, furnaces, trading,
  fishing, enchanting, vehicles, elytra, creative mode, books, signs, waypoints.
- **Real eyes** — `capture_view` screenshots a headless first-person renderer; the model sees.
- **One shared session** with fork/fold concurrency: every rail talks to the same history,
  no rail waits on another, provider failures are diagnosed by transcript shape.
- **Model providers** — Bedrock by default; OpenAI or Anthropic via `STRANDS_MODEL_PROVIDER`
  and their SDK package; one model instance shared by the primary and its workers.

### The nervous system
- **Reflexes** — a 300 ms LLM-free spinal cord: lava, dying, creeper blast radius, stuck,
  plus idle housekeeping (eat, armor, drops, personal space).
- **Sentinel** — event-driven senses: primed TNT/creepers, hostile radar, attacker naming,
  dusk, players joining, chests opened, base security around waypoints, low vitals —
  edge-triggered notes, not a firehose.
- **Digest** — an ≤ 8-line status block in front of every self-prompt.
- **Thinker** — idle reflection every 90 s; journey supervisor with a measured progress signal.
- **Legs lock** — one arbitration for the pathfinder across tools, reflexes and journeys.
- **Memory probe** — boot-time heap < mem_limit < VM audit, runtime census of every
  long-lived collection, a body-release routine that really frees a retired `Bot`.

### Long goals and many hands
- **Journeys** — "mine until 64 iron" as a persisted background loop with journal, Δ
  ledgers, `completed` / `too_hard` history; interrupted errands are reported after a restart.
- **Fleet** — `manage_bots` hires worker bots (own body, agent, legs, reflexes), supervised
  and dismissed by the boss; peer chat is logged, never answered.
- **A body that heals** — the signed-chat kick (mineflayer#3838) is survived by a proxy body.

### Seven rails
Game chat · CLI `you>` · push-to-talk (Whisper) · realtime speech call · web dashboard
(MJPEG eyes + SSE inner life + composer, WebAuthn passkeys, phone-first) · phone call from
the dashboard · [tiny.technology](https://tiny.technology) endpoint (`/api/health`,
token-gated telemetry / snapshot / stream / events / chat / stop; `tiny.body.json` manifest).

### Ship it
- `docker compose up -d` — Minecraft server + bot + dashboard, restart-on-OOM, volumes for
  world/passkeys/waypoints, optional Cloudflare tunnel profile.
- `npx strands-minecraft` — run from any directory with a `.env`; `npm start` from a clone.
- CI on Node 22: typecheck + tests + numbers freshness. Community files, issue/PR templates.
- Documentation: README, AGENTS.md (developer map), COVERAGE.md, HARDCODING.md, MEMORY.md,
  eight incident write-ups in `docs/findings/`, and a landing page.

[0.1.0]: https://github.com/cagataycali/strands-minecraft/releases/tag/v0.1.0
