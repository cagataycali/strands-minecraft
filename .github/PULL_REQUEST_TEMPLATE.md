## What

<!-- one paragraph: the behaviour before, the behaviour after -->

## Why

<!-- the issue, the soak finding (docs/findings/…), or the log line that made you do it -->

## Proof

- [ ] `npm test && npm run typecheck` green locally
- [ ] new behaviour has a test (fake world + fake bot — see `test/tools.test.ts`)
- [ ] tunables went through `src/config.ts`; no bare constants in a rail (HARDCODING.md)
- [ ] imports use the `.js` extension
- [ ] README / AGENTS.md / COVERAGE.md updated if a tool, rail or knob changed
- [ ] any new number the bot computes is printed once (boot line or feed)
