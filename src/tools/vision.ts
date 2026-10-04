import { tool, ImageBlock } from '@strands-agents/sdk';
import { z } from 'zod';
import type { Bot } from 'mineflayer';
import viewerPkg from 'prismarine-viewer';
const mineflayerViewer = viewerPkg.mineflayer;

const VIEWER_PORT = Number(process.env.VIEWER_PORT ?? 3007);

/** CAMERA_DISABLED=true — no viewer server, no Chrome, every camera call fails
 *  with this one sentence. For tests and headless CI boxes; the routes then
 *  answer their honest `broken:` placeholder instead of launching anything. */
export function cameraDisabledReason(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return /^(1|true|yes)$/i.test(env.CAMERA_DISABLED ?? '') ? 'camera disabled (CAMERA_DISABLED=true)' : undefined;
}

/** Is `port` free to listen on right now? The viewer's own listen() error is an
 *  uncaught exception (prismarine-viewer never exposes its http server), so the
 *  only safe move is to ask first — a worker camera that lands on a busy port
 *  (the dashboard's, another instance's) would otherwise kill the process. */
export async function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}
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

/** Did the headless browser die under us? puppeteer's Page object does NOT flip
 *  isClosed() when Chrome is killed from outside (measured 2026-10-04: a
 *  kill -9 on the renice'd pid left page.isClosed() === false and every
 *  screenshot throwing "Protocol error (Page.captureScreenshot): Session
 *  closed" — forever, until the bot restarted). The browser's connection flag
 *  is the honest one. */
function browserGone(): boolean {
  const b = state.browser as unknown as { connected?: boolean; isConnected?: () => boolean } | null;
  if (!b) return false;
  if (typeof b.connected === 'boolean') return !b.connected;
  if (typeof b.isConnected === 'function') return !b.isConnected();
  return false;
}

/** Errors that mean the page/browser is dead, not that one shot failed. A
 *  caller that sees one should resetCamera() and warm up again, not keep
 *  reporting the same `broken:` line until the process restarts. */
export function isCameraSessionError(message: string): boolean {
  return /Session closed|Target closed|Target\.detachFromTarget|detached|Navigating frame was detached|Connection closed|Browser has disconnected|Protocol error/i.test(message);
}

/** Should the stream rebuild the camera because the picture is flat? A live
 *  first-person frame is 20–60 KB at quality 60; a scene that lost its world
 *  (the viewer bound to a body that was replaced on reconnect) is a solid sky
 *  — a ~4 KB JPEG — for as long as nobody rebuilds it. Thresholds: ≥ `need`
 *  consecutive flat frames (≈30 s at 3 fps) and at most one rebuild per minute
 *  so a genuinely empty view (bot staring at the sky) cannot thrash Chrome. */
export function shouldRebuildCamera(
  s: { flatFrames: number; lastRebuildAt: number; now: number },
  need = 90,
  minGapMs = 60_000,
): boolean {
  return s.flatFrames >= need && s.now - s.lastRebuildAt >= minGapMs;
}

/** A frame is "flat" when the JPEG is implausibly small for a rendered world. */
export const FLAT_FRAME_BYTES = 6_000;

/** Tear the camera down completely — browser, page, viewer server — so the
 *  next ensureViewer() builds a fresh one on the CURRENT body. */
export async function resetCamera(bot: Bot): Promise<void> {
  // Worker pages live in the SAME browser: closing it kills them all, so
  // their bookkeeping must say so or the next request would screenshot ghosts.
  for (const id of [...workerCams.keys()]) await closeWorkerCamera(id);
  try { await state.browser?.close(); } catch { /* already gone */ }
  try { (bot as unknown as { viewer?: { close(): void } }).viewer?.close(); } catch { /* not started */ }
  state.browser = null;
  state.page = null;
  state.started = false;
  state.needsReload = false;
}

// ── 👷 worker cameras: one viewer per worker, one PAGE each, ONE Chrome ──────

interface WorkerCam {
  id: string;
  port: number;
  bot: Bot;
  started: boolean;
  page: import('puppeteer-core').Page | null;
  warmingSince?: number;
  /** one warm-up at a time per worker — ensure is not re-entrant */
  warming?: Promise<import('puppeteer-core').Page>;
}

const workerCams = new Map<string, WorkerCam>();

/** How many worker cameras exist right now — the memcheck collection (MEMORY.md rule 3). */
export function workerCameraCount(): number {
  return workerCams.size;
}

/** Viewer ports the worker cameras hold — so a new one is allocated past them. */
export function workerViewerPorts(): number[] {
  return [...workerCams.values()].map((c) => c.port);
}

/** The viewer port worker `id`'s camera actually bound (it may have walked past a busy one). */
export function workerCameraPort(id: string): number | undefined {
  return workerCams.get(id)?.port;
}

export function workerCameraWarmup(id: string): { sinceMs: number } | undefined {
  const c = workerCams.get(id);
  return c?.warmingSince === undefined ? undefined : { sinceMs: Date.now() - c.warmingSince };
}

/**
 * The page that shows worker `id`'s eyes. First call starts a prismarine-viewer
 * on the worker's own bot at `port` and opens a tab for it in the shared
 * headless Chrome (launched here if the main camera has not yet); later calls
 * return the warm page. A worker camera shares FRAME_MS, the browser, and the
 * renice with the main one — it costs one more viewer server and one more tab,
 * not a second Chrome.
 */
export async function getWorkerCameraPage(id: string, bot: Bot, port: number): Promise<import('puppeteer-core').Page> {
  if (browserGone()) {
    for (const c of workerCams.values()) { c.page = null; }
    state.browser = null;
    state.page = null;
  }
  let cam = workerCams.get(id);
  if (!cam) {
    cam = { id, port, bot, started: false, page: null };
    workerCams.set(id, cam);
  }
  if (cam.page && !cam.page.isClosed()) return cam.page;
  if (cam.warming) return cam.warming;
  cam.warming = (async () => {
    cam!.warmingSince = Date.now();
    try {
      const off = cameraDisabledReason();
      if (off) throw new Error(off);
      if (!cam!.started) {
        // Walk forward from the allocated port until one is free: the viewer's
        // listen() failure would be an uncaught exception, not a rejection.
        let tries = 0;
        while (!(await portFree(cam!.port))) {
          cam!.port++;
          if (++tries > 50) throw new Error(`no free viewer port near ${cam!.port - tries} for worker ${id}`);
        }
        mineflayerViewer(bot, { port: cam!.port, firstPerson: true, viewDistance: 3 });
        cam!.started = true;
      }
      const browser = await ensureBrowser();
      const page = await browser.newPage();
      await page.setViewport({ width: 960, height: 540 });
      await page.goto(`http://localhost:${cam!.port}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('canvas', { timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      cam!.page = page;
      return page;
    } finally {
      cam!.warmingSince = undefined;
      cam!.warming = undefined;
    }
  })();
  return cam.warming;
}

/** A dead worker closes its page and its viewer — nothing of it stays in Chrome. */
export async function closeWorkerCamera(id: string): Promise<boolean> {
  const cam = workerCams.get(id);
  if (!cam) return false;
  workerCams.delete(id);
  try { if (cam.page && !cam.page.isClosed()) await cam.page.close(); } catch { /* browser already gone */ }
  try { (cam.bot as unknown as { viewer?: { close(): void } }).viewer?.close(); } catch { /* not started */ }
  cam.page = null;
  cam.started = false;
  return true;
}

async function ensureViewer(bot: Bot): Promise<import('puppeteer-core').Page> {
  const off = cameraDisabledReason();
  if (off) throw new Error(off);
  if (browserGone()) {
    // Chrome died (killed, crashed, OOM): the page handle is a ghost. Drop both
    // and fall through to a full warm-up instead of screenshotting a corpse.
    state.browser = null;
    state.page = null;
  }
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

/** The one headless Chrome every camera page lives in — launched on first use,
 *  relaunched after it died (browserGone). Main camera and worker cameras share
 *  it: N pictures = N tabs, never N browsers. */
async function ensureBrowser(): Promise<import('puppeteer-core').Browser> {
  if (state.browser && !browserGone()) return state.browser;
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
  return state.browser;
}

async function warmUp(_bot: Bot): Promise<import('puppeteer-core').Page> {
  const browser = await ensureBrowser();
  state.page = await browser.newPage();
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
  for (const id of [...workerCams.keys()]) await closeWorkerCamera(id);
  try {
    await state.browser?.close();
  } catch { /* already closed */ }
  try {
    (bot as unknown as { viewer?: { close(): void } }).viewer?.close();
  } catch { /* not started */ }
}
