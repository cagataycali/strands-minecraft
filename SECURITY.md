# Security

## Report privately

Please do **not** open a public issue for a vulnerability. Use GitHub's private
[security advisory](https://github.com/cagataycali/strands-minecraft/security/advisories/new)
for this repository. You will get an acknowledgement, and a fix or a reasoned answer
before anything is disclosed.

## What guards what

The bot exposes a web dashboard (`:3008`) and a first-person viewer (`:3007`). Assume both
are reachable by more than you once a tunnel is involved.

| surface | gate | notes |
|---|---|---|
| Dashboard pages, `/api/say`, `/api/events`, MJPEG | **WebAuthn passkeys** (`src/web/auth.ts`) | Enroll once, Face ID / Touch ID after. Passkeys bind to the HTTPS origin — the tunnel is what makes them work. Store: `.web_auth.json` (Docker: a volume). Reset = delete the file. |
| First passkey enrollment | `WEB_BOOTSTRAP_TOKEN` | The open window. Set it before exposing the dashboard, or the first visitor enrolls. |
| tiny endpoint routes (`/api/telemetry`, `/api/camera/snapshot`, `/api/stream.mjpeg`, `/api/events`, `POST /api/chat`, `POST /api/stop`) | `TINY_TOKEN` bearer / `?token=` / passkey cookie (`src/web/tiny.ts`) | ≥ 32 chars, `openssl rand -hex 32`. Fail-closed: without it every remote caller gets `401`. Writes are rate-limited (5/s per token). `GET /api/health` is public by design and carries no secrets. |
| `WEB_AUTH_DISABLED=true` | **loopback only** | It disables the passkey gate for `127.0.0.1` requests. From Docker's bridge or a tunnel, every caller still needs the token. Never set it on an exposed host. |
| Minecraft server (bundled compose) | `ONLINE_MODE=FALSE` | Offline auth so the bot can join without a Microsoft account — gate `:25565` with your firewall. |

## Secrets

Model credentials (`AWS_*`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), `TINY_TOKEN` and
`WEB_BOOTSTRAP_TOKEN` live in `.env`, which is git-ignored (`.env.*` too, except
`.env.example`). The dashboard feed never prints them; the session's provider diagnostics
dump transcript *shape* only (roles + tool-pair ids, never content).

## Scope

The agent executes tools in a game world on your behalf. Prompt injection through game chat
(a player telling the bot to do something) is a *feature boundary*, not a vulnerability —
report it if it lets a stranger reach anything outside the game (the host, the dashboard,
your credentials).
