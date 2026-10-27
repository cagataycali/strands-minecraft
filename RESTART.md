# RESTART.md — putting the new page live

The page is served by the bot process itself (`GET /` in `src/web.ts`), so the
redesign goes live the moment the bot restarts on `main`. Nothing else changes:
same routes, same passkeys, same tunnel.

## Docker (compose — the documented way)

```sh
cd ~/strands-minecraft && git pull --ff-only
docker compose build bot
docker compose up -d bot            # recreates only the bot; the server + tunnel keep running
docker compose logs -f bot | head -40
```

The image copies `src/` only — the fonts the page needs now live in
`src/web/assets/` (not `docs/fonts/`) for exactly that reason.

## Running from the Mac with tsx (how StrandsBot and Frend run today)

```sh
cd ~/strands-minecraft && git pull --ff-only
npx strands-minecraft ls                                  # pids + ports of every instance
pkill -f "tsx src/index.ts"                               # StrandsBot (:3008) and Frend (:3208) both stop
nohup npx tsx src/index.ts > /tmp/strandsbot.log 2>&1 &   # StrandsBot
npx strands-minecraft start Frend                         # Frend, from instances/Frend.env (logs/Frend.log)
```

## Check

```sh
curl -s http://127.0.0.1:3008/ | grep -c 'data-scheme'      # ≥ 1: the new page
curl -sI http://127.0.0.1:3008/fonts/inter-latin.woff2 | head -1   # 200
```

Then open https://minecraft.cagatay.my on the phone (dark by default; the
contrast button in the topbar or the settings drawer flips to paper). A hard
reload is not needed — the page is not cached.

## Preview without the bot

```sh
npx tsx scripts/preview-page.mjs          # http://127.0.0.1:3077  (SCENARIO=warming|stale|dead|unreachable|idle, GATE=1)
```
