# Contributing

Thanks for wanting to give the bot a better body. Two documents already do most of the
onboarding — read them first:

- [AGENTS.md](AGENTS.md) — the developer map: how the rails fit, where each file lives,
  the hard-won rules (written for coding agents, works for humans).
- [HARDCODING.md](HARDCODING.md) — which decisions belong in code and which belong to the model.

## Run it

```bash
npm install
cp .env.example .env          # MC_HOST/MC_PORT + model credentials
npm start                     # tsx src/index.ts — the you> prompt opens when the bot joins
npm run dev                   # tsx watch — restarts on save
```

Docker (`docker compose up -d`) is the full rig; bare metal is what you want while
changing code. Node ≥ 22.

## Before you open a pull request

```bash
npm test && npm run typecheck
```

Both must be green — CI runs exactly these two commands on Node 22. Tests are plain
`node:test` via `tsx --test test/*.test.ts` (~785 cases, under a minute). They run on the
host, not in the container image (it ships `src`, not `test`).

House rules, the short version:

- **Import extensions are `.js` even for `.ts` files** (ESM / NodeNext). Match it.
- **Tunables live in `src/config.ts`** with an env override and a one-line "why this default".
  Don't add a bare `const THRESHOLD = …` in a rail. HARDCODING.md sorts every constant into
  (a) mechanism, (b) tunable, (c) policy — and (c) belongs in a tool parameter or the prompt.
- **New tool → new test.** `test/tools.test.ts` and `test/fake-bot.ts` show the style: a fake
  world, a fake bot, assert on what the tool *did*, never on prose.
- **Numbers say themselves.** A computed budget or price that never prints is
  indistinguishable from a broken one — log it once at boot or in the feed.
- **Notes never push into a live history**; they ride the `NoteQueue` in front of the next turn.
- Every image in the README is the bot's own first-person capture. No stock art.

## Where findings go

A bug found in a live soak is a finding before it is a fix: write it up in
[docs/findings/](docs/findings/) (see the existing ones — reproduction, mechanism, remedy,
what the tests now pin), reference the issue number, then open the PR. Memory forensics
belong in [MEMORY.md](MEMORY.md).

## Reporting

- Bugs and feature requests: GitHub issues (templates attached). Include the boot lines,
  `docker compose logs bot` if you run the rig, and the Minecraft version.
- Security: see [SECURITY.md](SECURITY.md) — please don't open a public issue for those.

By contributing you agree your work is released under the [MIT license](LICENSE).
