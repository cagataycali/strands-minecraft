# The bot. Chromium is the only heavyweight guest: capture_view (the agent's
# eyes) and the dashboard camera both render through a headless first-person
# viewer. Voice rails (mic/speaker) stay host-only by nature — everything else
# works in here.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      # node-canvas (prismarine-viewer) runtime libs, in case a prebuilt
      # binary is not available for this arch and it builds from source
      libcairo2 libpango-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
      && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium \
    # the OOM lesson of 2026-08-17: a 4GB heap died mid-fleet. Cap the heap
    # BELOW the container limit so V8 GCs hard instead of the kernel killing
    # us blind — and docker restarts us if it still goes down. That layering
    # only holds while the container limit is below memory that EXISTS, so
    # compose overrides this with BOT_HEAP_MB and the bot audits all three
    # numbers at boot (src/memcheck.ts, issue #13).
    NODE_OPTIONS=--max-old-space-size=2048

WORKDIR /app

# full install, not --omit=dev: the app RUNS through tsx (a devDependency)
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Persistent state lives on volumes (see compose): passkeys + waypoints
ENV WEB_AUTH_STORE=/data/web_auth.json
VOLUME /data /root/.strands-minecraft

EXPOSE 3007 3008
CMD ["npx", "tsx", "src/index.ts"]
