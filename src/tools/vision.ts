import { tool, ImageBlock } from '@strands-agents/sdk';
import { z } from 'zod';
import type { Bot } from 'mineflayer';
import viewerPkg from 'prismarine-viewer';
const mineflayerViewer = viewerPkg.mineflayer;

const VIEWER_PORT = Number(process.env.VIEWER_PORT ?? 3007);
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
].filter(Boolean) as string[];

interface ViewerState {
  started: boolean;
  page: import('puppeteer-core').Page | null;
  browser: import('puppeteer-core').Browser | null;
}

const state: ViewerState & { warmingSince?: number; needsReload?: boolean } = { started: false, page: null, browser: null };

/** Chunk streaming + mesh building is what makes the first frames grey — wait it
 *  out once, in one place, for both a cold start and a post-reconnect reload. */
const SETTLE_MS = Number(process.env.CAMERA_SETTLE_MS ?? 6_000);

/** Is the camera warming up right now, and for how long? The loop watchdog reads
 *  this so a stall line can ACCUSE the camera instead of merely reporting lag
 *  (issue #18 — this warm-up is what got the bot kicked). */
export function cameraWarmup(): { sinceMs: number } | undefined {
  return state.warmingSince === undefined ? undefined : { sinceMs: Date.now() - state.warmingSince };
}

/** Drop the headless browser's CPU priority (see the call site). Exported so a
 *  test can prove it never throws, whatever the platform says. */
export async function nicenChrome(
  browser: { process: () => { pid?: number } | null },
  run?: (cmd: string, args: string[]) => Promise<void>,
): Promise<boolean> {
  const pid = browser.process()?.pid;
  if (!pid) return false;
  const nice = Number(process.env.CAMERA_NICE ?? 10);
  if (!Number.isFinite(nice) || nice <= 0) return false;
  const exec = run ?? (async (cmd, args) => {
    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => execFile(cmd, args, (err) => (err ? reject(err) : resolve())));
  });
  try {
    await exec('renice', ['-n', String(nice), '-p', String(pid)]);
    console.log(`🎥 camera renice ${nice} on chrome pid ${pid} — the keep-alive outranks the picture`);
    return true;
  } catch {
    return false; // no renice, no permission, not POSIX — the camera just stays greedy
  }
}

async function ensureViewer(bot: Bot): Promise<import('puppeteer-core').Page> {
  if (!state.started) {
    mineflayerViewer(bot, { port: VIEWER_PORT, firstPerson: true, viewDistance: 4 });
    state.started = true;
  }
  if (state.page && !state.page.isClosed()) {
    if (!state.needsReload) return state.page;
    // The body reconnected under the camera: this page's socket.io client was
    // talking to the viewer instance that just died, so the scene it holds is a
    // photograph of a dead world. Reload — cheap (no Chrome launch, so no
    // repeat of the warm-up stall that got us kicked) and, unlike hoping
    // socket.io reconnects into a freshly-created server, deterministic.
    state.needsReload = false;
    try {
      await state.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      await state.page.waitForSelector('canvas', { timeout: 15_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      return state.page;
    } catch {
      // A page that will not reload is worse than no page: drop it and let the
      // full warm-up below build a new one.
      try { await state.page.close(); } catch { /* already gone */ }
      state.page = null;
    }
  }

  state.warmingSince = Date.now();
  try {
    return await warmUp(bot);
  } finally {
    state.warmingSince = undefined;
  }
}

async function warmUp(_bot: Bot): Promise<import('puppeteer-core').Page> {
  const { launch } = await import('puppeteer-core');
  const fs = await import('node:fs');
  const executablePath = CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!executablePath) {
    throw new Error(
      'No Chrome/Chromium found for headless rendering. Install Google Chrome or set CHROME_PATH.'
    );
  }
  state.browser = await launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu-sandbox', ...chromeGlArgs()],
  });
  // The camera may not outrank the bot's own connection (issue #18: the first
  // watcher's warm-up starved the loop long enough that the vanilla server sent
  // disconnect.timeout, and the next write hit a dead socket). Chrome's renderer
  // will happily take every core it can get on a 2-core VM, so hand it a worse
  // priority than the process that owes the server a keep-alive. Best effort:
  // renice can be refused, and Windows has no such command — a camera that
  // stays greedy is a nuisance, a crash here would be worse.
  await nicenChrome(state.browser);
  state.page = await state.browser.newPage();
  await state.page.setViewport({ width: 960, height: 540 });
  // 'domcontentloaded', NOT 'networkidle2': the viewer page holds a live
  // socket.io connection streaming chunks forever, so the network is NEVER
  // idle and networkidle2 could only ever end in its own timeout. Measured on
  // the running viewer (2026-08-17): networkidle2 → timeout at 20s every time,
  // domcontentloaded → resolves, screenshot 0.8s later. That timeout was the
  // whole reason the dashboard reported `frames: 0` forever.
  await state.page.goto(`http://localhost:${VIEWER_PORT}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // The scene renders into a canvas the page creates itself — wait for it
  // instead of guessing, then still settle: chunk streaming + mesh building
  // is what makes the first frames grey.
  await state.page.waitForSelector('canvas', { timeout: 15000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  return state.page;
}

/** After a reconnect the viewer's socket points at a dead bot — restart it on
 *  the new one. The browser survives; only the world stream rebinds. */
export function resetViewer(oldBot: Bot) {
  // The next camera user must reload the page, not photograph the dead world.
  state.needsReload = true;
  try {
    (oldBot as unknown as { viewer?: { close(): void } }).viewer?.close();
  } catch { /* not started */ }
  state.started = false;
}

/**
 * How Chrome gets a GL context — the difference between a picture and a white
 * rectangle. In the Docker image (Debian chromium, no GPU) `--use-gl=angle`
 * alone yields NO WebGL at all: every frame the dashboard ever streamed from a
 * container was a 3.8 KB white JPEG (measured 2026-09-22 — three flag sets,
 * only SwiftShader produced a renderer). On a Mac with real Chrome the GPU path
 * is right and SwiftShader would only make it slow. CHROME_ARGS overrides both
 * (space-separated) for anyone whose machine is neither.
 */
export function chromeGlArgs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (env.CHROME_ARGS?.trim()) return env.CHROME_ARGS.trim().split(/\s+/);
  if (platform === 'linux') return ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  return ['--use-gl=angle'];
}

/** The web dashboard's camera: the same headless page capture_view uses.
 *  Sharing it means the stream and the agent literally see the same pixels. */
export function getCameraPage(bot: Bot) {
  return ensureViewer(bot);
}

export function visionTools(bot: Bot) {
  const captureView = tool({
    name: 'capture_view',
    description:
      "SEE the world: capture a first-person screenshot from your own eyes and look at it. Use before/after building, to check what something looks like, to find visual landmarks, or whenever text descriptions aren't enough. Turn or look_at first to aim your view.",
    inputSchema: z.object({
      waitMs: z
        .number()
        .default(800)
        .describe('Extra settle time before the shot, ms (default 800; use ~2000 right after moving far)'),
    }),
    callback: async ({ waitMs }) => {
      const page = await ensureViewer(bot);
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 8000)));
      const png = (await page.screenshot({ type: 'png' })) as Uint8Array;
      return new ImageBlock({
        format: 'png',
        source: { bytes: png },
      });
    },
  });

  return [captureView];
}

export async function closeViewer(bot: Bot) {
  try {
    await state.browser?.close();
  } catch { /* already closed */ }
  try {
    (bot as unknown as { viewer?: { close(): void } }).viewer?.close();
  } catch { /* not started */ }
}
