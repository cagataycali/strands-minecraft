/**
 * 📱 The phone page — one HTML string, zero build step.
 *
 * Design constraints that shaped it:
 *  - iOS Safari is the primary client: MJPEG in <img>, EventSource, WebAuthn
 *    via navigator.credentials — all native there, nothing polyfilled.
 *  - No bundler: the WebAuthn base64url<->ArrayBuffer glue is ~20 lines, not
 *    worth a dependency and a dist/ directory in this repo.
 *  - Dark, quiet, thumb-reachable input. The video is the hero; the feed
 *    scrolls under it; the composer sticks to the bottom above the keyboard.
 */
import { veilFor } from './veil.js';
import { BRAND_HTML } from './brand.js';
import { stopReceipt, mcClock, vitalsModel, systemTone, inventoryModel, crewTitle, displayText, stageModel, workerStageState, thumbPlan } from './hud.js';

export const PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="StrandsBot">
<meta name="theme-color" content="#000000">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png">
<link rel="preload" as="font" type="font/woff2" crossorigin href="/fonts/inter-latin.woff2">
<link rel="preload" as="font" type="font/woff2" crossorigin href="/fonts/jetbrains-mono-latin.woff2">
<title>StrandsBot · live</title>
<script>
// Scheme before paint: localStorage 'mc-scheme' (paper|dark), else the phone is
// dark (the video is the hero) and the desktop follows the OS.
(function () {
  var s; try { s = localStorage['mc-scheme']; } catch (e) { s = null; }
  if (s !== 'dark' && s !== 'paper') s = matchMedia('(max-width: 899px)').matches || matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'paper';
  document.documentElement.dataset.scheme = s;
  var m = document.querySelector('meta[name=theme-color]'); if (m) m.content = s === 'dark' ? '#000000' : '#ffffff';
})();
</script>
<style>
  /* Strands design language (expo-the-arm/dashboard styles.css, strands-labs/robots extra.css): white or black
     surfaces, the Strands green, JetBrains Mono for labels and numbers over Inter text, 1px borders, 8px radius.
     No glass, no blur, no shadows; the one gradient is the scrim under the HUD on the video. Minecraft rides on
     top: pixel sprites (hearts, food, the frog), a 9-slot hotbar, an XP-bar progress line, 2px block borders on
     slots and STOP — the one place radius is 0. */
  @font-face { font-family: "Inter"; font-style: normal; font-weight: 100 900; font-display: swap; src: url("/fonts/inter-latin.woff2") format("woff2"); }
  @font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 100 800; font-display: swap; src: url("/fonts/jetbrains-mono-latin.woff2") format("woff2"); }
  :root {
    --sr-radius: 8px;
    --sr-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --sr-sans: "Inter", -apple-system, system-ui, sans-serif;
    --sr-black: #000000; --sr-charcoal-1: #28292a; --sr-charcoal-2: #3d3c3c;
    --safe-top: env(safe-area-inset-top, 0px); --safe-bot: env(safe-area-inset-bottom, 0px); --safe-l: env(safe-area-inset-left, 0px); --safe-r: env(safe-area-inset-right, 0px);
    --topbar-h: 3.4rem;
    --sr-scheme: paper;
    --sr-bg: #ffffff; --sr-fg: var(--sr-black);
    --sr-accent: #007a3d; --sr-accent-bright: #02a435; --sr-accent-soft: rgba(2, 164, 53, 0.12); --sr-on-accent: #ffffff;
    --sr-ink-2: var(--sr-charcoal-2); --sr-ink-3: #666464; --sr-muted: #767373;
    --sr-rule: rgba(0, 0, 0, 0.15);
    --sr-card-bg: #ffffff; --sr-card-border: var(--sr-black);
    --sr-chip-bg: #f4f4f4; --sr-code-inline: #f4f4f4; --sr-kbd: #f4f4f4;
    --sr-code-bg: #f6f8fa; --sr-code-fg: #24292e; --sr-term-head: #eaeef2;
    --sr-pill-bg: #ffffff; --sr-pill-border: #999696;
    --sr-surface-green: #e6f6e7;
    --sr-viewer-bg: #f4f4f4; --sr-grid-major: #b6b6b6; --sr-grid-minor: #d9d9d9;
    --sr-warn: #946e00; --sr-on-warn: #ffffff;
    --sr-scrim: rgba(0, 0, 0, 0.35);
    --sr-danger: #c62828; --sr-danger-soft: rgba(198, 40, 40, 0.12); --sr-on-danger: #ffffff; --sr-info: #2456c4;
    /* minecraft flavour */
    --mc-px: 2px; --mc-heart: #c62828; --mc-food: #9a5a1c; --mc-armor: #666464; --mc-slot-border: #999696;
    color-scheme: light;
  }
  html[data-scheme="dark"] {
    --sr-scheme: dark;
    --sr-bg: var(--sr-black); --sr-fg: #ffffff;
    --sr-accent: #00cc60; --sr-accent-bright: #00cc60; --sr-accent-soft: rgba(0, 204, 96, 0.14); --sr-on-accent: var(--sr-black);
    --sr-ink-2: #b6b6b6; --sr-ink-3: #999696; --sr-muted: #999696;
    --sr-rule: var(--sr-charcoal-1);
    --sr-card-bg: var(--sr-black); --sr-card-border: #ffffff;
    --sr-chip-bg: var(--sr-charcoal-1); --sr-code-inline: var(--sr-charcoal-2); --sr-kbd: var(--sr-charcoal-1);
    --sr-code-bg: #24292e; --sr-code-fg: #e1e4e8; --sr-term-head: #2f363d;
    --sr-pill-bg: var(--sr-charcoal-1); --sr-pill-border: var(--sr-charcoal-2);
    --sr-surface-green: color-mix(in srgb, var(--sr-accent) 74%, #000);
    --sr-viewer-bg: #111213; --sr-grid-major: #46505c; --sr-grid-minor: #303740;
    --sr-warn: #f6bc00; --sr-on-warn: var(--sr-black);
    --sr-scrim: rgba(0, 0, 0, 0.6);
    --sr-danger: #ff5d5d; --sr-danger-soft: rgba(255, 93, 93, 0.16); --sr-on-danger: #140000; --sr-info: #7cb7ff;
    --mc-heart: #ff5d5d; --mc-food: #d8882e; --mc-armor: #b6b6b6; --mc-slot-border: #3d3c3c;
    color-scheme: dark;
  }
  * { box-sizing: border-box; margin: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body { background:var(--sr-bg); color:var(--sr-fg); font:14px/1.45 var(--sr-sans);
         display:flex; flex-direction:column; height:100dvh; -webkit-tap-highlight-color:transparent; overscroll-behavior:none; }
  button, input { font:inherit; color:inherit; }
  button { cursor:pointer; background:none; border:0; padding:0; }
  button:disabled { cursor:not-allowed; }
  :focus-visible { outline:2px solid var(--sr-accent); outline-offset:2px; }
  svg.frog, svg.wordmark { display:block; shape-rendering:crispEdges; }
  img, .px { image-rendering:pixelated; }
  /* topbar strip: the brand lockup, the live dot, scheme + menu */
  #top { flex:none; display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:var(--topbar-h);
         padding:var(--safe-top) calc(12px + var(--safe-r)) 0 calc(12px + var(--safe-l)); background:var(--sr-bg); border-bottom:1px solid var(--sr-rule); }
  .brand { display:flex; align-items:center; gap:8px; min-width:0; color:var(--sr-fg); }
  .brand .frog { width:22px; height:22px; color:var(--sr-accent); flex:none; }
  .brand .brand-link { display:flex; color:var(--sr-accent); }
  .brand .wordmark { height:13px; width:auto; }
  .brand .project { font:600 12.5px var(--sr-mono); white-space:nowrap; }
  #topright { display:flex; align-items:center; gap:6px; }
  .pill { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; min-height:28px; border-radius:999px;
          background:var(--sr-pill-bg); border:1px solid var(--sr-pill-border); color:var(--sr-fg); font:500 11.5px/1 var(--sr-mono); letter-spacing:.02em; white-space:nowrap; }
  #live { gap:7px; }
  #dot { width:7px; height:7px; border-radius:50%; background:var(--sr-warn); flex:none; }
  #dot.ok { background:var(--sr-accent); animation:pulse 2.4s infinite; } #dot.warn { background:var(--sr-warn); }
  #live:not(.ok) { border-color:var(--sr-warn); color:var(--sr-warn); }
  @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.45 } }
  .icon-btn { width:36px; height:36px; border-radius:999px; background:var(--sr-pill-bg); border:1px solid var(--sr-pill-border); color:var(--sr-fg);
              display:grid; place-items:center; flex:none; }
  .icon-btn svg { width:16px; height:16px; stroke:currentColor; fill:none; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .icon-btn:hover { border-color:var(--sr-accent); }
  /* the stage: the video with the F3 HUD on top and the vitals HUD + STOP at the bottom; a tap toggles fullscreen */
  #stage { flex:none; background:var(--sr-bg); }
  #eyes { position:relative; }
  #view { position:relative; background:#000; } /* the HUD and the veil anchor to the VIDEO, not the strip below it */
  #video { width:100%; aspect-ratio:16/9; background:#000; object-fit:cover; display:block; }
  #view.stale #video { filter:grayscale(.6) brightness(.8); }
  #stage.full { position:fixed; inset:0; z-index:50; display:flex; flex-direction:column; justify-content:center; background:#000; }
  #stage.full #eyes { flex:1; min-height:0; display:flex; flex-direction:column; }
  #stage.full #view { flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; }
  #stage.full #video { aspect-ratio:auto; height:100%; min-height:0; object-fit:contain; }
  #stage.full #xp, #stage.full #vitals { display:none; }
  /* F3-style debug HUD: mono, white on the scrim, tabular */
  #f3 { position:absolute; left:0; right:0; top:0; padding:8px 12px 22px; pointer-events:none; color:#fff;
        font:500 11px/1.5 var(--sr-mono); font-variant-numeric:tabular-nums; text-shadow:0 1px 2px rgba(0,0,0,.9);
        background:linear-gradient(rgba(0,0,0,.6), transparent); display:flex; justify-content:space-between; gap:12px; }
  #f3 > div { min-width:0; } #f3 .r { text-align:right; }
  #f3 .k { color:rgba(255,255,255,.6); margin-right:6px; }
  #f3 .tag { display:inline-block; padding:0 5px; border:1px solid #fff; font-weight:700; letter-spacing:.1em; font-size:9.5px; line-height:14px; margin-left:6px; vertical-align:1px; }
  #f3 .tag.stale { border-color:var(--sr-warn); color:var(--sr-warn); }
  #hud { position:absolute; left:0; right:0; bottom:0; padding:28px 12px 10px;
         background:linear-gradient(transparent, rgba(0,0,0,.72));
         display:flex; align-items:flex-end; gap:12px; pointer-events:none; color:#fff; }
  .bars { display:flex; flex-direction:column; gap:3px; }
  .bar { display:flex; gap:2px; height:11px; }
  .bar svg { width:11px; height:11px; display:block; shape-rendering:crispEdges; }
  #hearts .on { fill:var(--mc-heart); } #food .on { fill:var(--mc-food); } #armor .on { fill:var(--mc-armor); }
  .bar .off { fill:rgba(255,255,255,.28); } .bar .shade { fill:rgba(0,0,0,.55); }
  #armor[hidden] { display:none; }
  #hudright { margin-left:auto; display:flex; align-items:flex-end; gap:8px; }
  /* The one control on the stage. Reflex-level: POST /api/stop halts the pathfinder, controls, digging and the journey
     without buying a model turn. A Minecraft block button: 2px hard border, no radius, big enough for a thumb (44px). */
  #stopBtn { pointer-events:auto; flex:none; min-width:72px; height:44px; padding:0 14px; border-radius:0;
             background:var(--sr-danger); color:var(--sr-on-danger); border:var(--mc-px) solid #fff;
             font:800 13px var(--sr-mono); letter-spacing:.14em; text-shadow:none; }
  #stopBtn:active, #stopBtn.busy { filter:brightness(1.12); transform:translateY(1px); }
  #stopBtn:disabled { opacity:.6; }
  #stageback { pointer-events:auto; display:none; flex:none; height:44px; padding:0 12px; border-radius:0;
               background:rgba(0,0,0,.55); color:#fff; border:var(--mc-px) solid #fff; font:600 12px var(--sr-mono); text-shadow:none; }
  #stageback.show { display:block; }
  /* XP bar: the task in flight as a thin green line; the level badge at its end */
  #xp { position:relative; height:4px; background:var(--sr-chip-bg); overflow:hidden; }
  #xp[hidden] { display:none; }
  #xp span { position:absolute; left:0; top:0; bottom:0; width:40%; background:var(--sr-accent); }
  #xp.busy span { animation:xpshimmer 2.2s linear infinite; }
  @keyframes xpshimmer { from { left:-40%; } to { left:100%; } }
  /* Vitals strip under the video — the body card's state line, chips from /api/telemetry and the HOTBAR. */
  #vitals { position:relative; background:var(--sr-bg); border-bottom:1px solid var(--sr-rule); padding:9px 12px 10px;
            display:flex; flex-direction:column; gap:7px; cursor:default; }
  #vitals.stale .vchip, #vitals.stale #vstate { color:var(--sr-muted); }
  #vhead { display:flex; align-items:center; gap:8px; min-height:28px; }
  #vstate { flex:1; min-width:0; font:600 13px var(--sr-mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #vstate::before { content:'\u25B8 '; color:var(--sr-accent); }
  #vitals.stale #vstate::after { content:' \u00b7 stale'; color:var(--sr-warn); font-weight:500; }
  #vchips { display:flex; gap:6px; overflow-x:auto; scrollbar-width:none; -webkit-overflow-scrolling:touch; }
  #vchips::-webkit-scrollbar { display:none; }
  .vchip { flex:none; display:inline-flex; align-items:center; gap:5px; min-height:24px; padding:2px 9px; border-radius:999px;
           background:var(--sr-chip-bg); color:var(--sr-ink-2); font:500 11px var(--sr-mono); font-variant-numeric:tabular-nums; }
  .vchip b { color:var(--sr-fg); font-weight:600; text-transform:uppercase; font-size:9.5px; letter-spacing:.06em; }
  .vchip.warn { color:var(--sr-warn); } .vchip.bad { color:var(--sr-danger); }
  #invBtn { flex:none; min-height:28px; padding:3px 10px; }
  #invBtn[aria-expanded="true"] { background:var(--sr-accent); border-color:var(--sr-accent); color:var(--sr-on-accent); }
  /* the hotbar: 9 slots, 2px block borders, the held slot framed in ink like the game's selector */
  #hotbar { display:grid; grid-template-columns:repeat(9, 1fr); gap:3px; max-width:440px; }
  .slot { position:relative; aspect-ratio:1; min-width:0; background:var(--sr-chip-bg); border:var(--mc-px) solid var(--mc-slot-border); border-radius:0;
          display:grid; place-items:center; font:600 10.5px var(--sr-mono); color:var(--sr-ink-2); overflow:hidden; }
  .slot .ab { text-transform:lowercase; letter-spacing:.02em; }
  .slot b { position:absolute; right:2px; bottom:0; font-size:10px; color:var(--sr-fg); font-variant-numeric:tabular-nums; }
  .slot.held { border-color:var(--sr-fg); color:var(--sr-fg); outline:1px solid var(--sr-fg); outline-offset:1px; }
  .slot.blank { background:transparent; }
  #inv { display:grid; grid-template-columns:repeat(auto-fill, minmax(104px, 1fr)); gap:4px; }
  #inv[hidden] { display:none; }
  #inv .row { display:flex; justify-content:space-between; gap:6px; background:var(--sr-chip-bg); border:var(--mc-px) solid var(--mc-slot-border);
              padding:4px 8px; font:500 11px var(--sr-mono); color:var(--sr-ink-2); white-space:nowrap; overflow:hidden; }
  #inv .row span { overflow:hidden; text-overflow:ellipsis; } #inv .row b { color:var(--sr-fg); font-variant-numeric:tabular-nums; }
  #inv .row.held { border-color:var(--sr-fg); color:var(--sr-fg); }
  #inv .row.empty { grid-column:1/-1; color:var(--sr-muted); justify-content:center; border-style:dashed; }
  /* the veil over the video: one honest line in a card, a pixel spinner that steps */
  #vstall { position:absolute; inset:0; display:none; align-items:center; justify-content:center; padding:16px; background:var(--sr-scrim); }
  #vstall.show { display:flex; }
  #vstall > span { display:flex; align-items:center; gap:10px; max-width:100%; padding:9px 14px; background:var(--sr-bg); color:var(--sr-fg);
                 border:1px solid var(--sr-card-border); border-radius:var(--sr-radius); font:500 12px/1.4 var(--sr-mono); }
  #vstall.warn > span { color:var(--sr-warn); border-color:var(--sr-warn); } #vstall.bad > span { color:var(--sr-danger); border-color:var(--sr-danger); }
  #vstall .spin.off { display:none; }
  .spin { width:12px; height:12px; flex:none; border:3px solid var(--sr-rule); border-top-color:var(--sr-accent); border-radius:0; animation:spin 1s steps(8) infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  /* the agent dock: crew strip, filters, the feed, quick chips, the composer */
  #feed { flex:1; overflow-y:auto; padding:10px 14px; -webkit-overflow-scrolling:touch; scrollbar-width:thin; }
  .ev { display:flex; flex-direction:column; margin:0 0 10px; word-wrap:break-word; }
  .ev .bubble { max-width:86%; padding:8px 12px; border-radius:var(--sr-radius); white-space:pre-wrap; line-height:1.5; }
  .ev .meta { font:500 10px var(--sr-mono); text-transform:uppercase; letter-spacing:.08em; color:var(--sr-muted); margin:3px 2px 0; }
  .ev.in { align-items:flex-end; }
  .ev.in .bubble { background:var(--sr-fg); color:var(--sr-bg); }
  .ev.in.pending .bubble { opacity:.55; }
  .ev.out { align-items:flex-start; }
  .ev.out .bubble { background:var(--sr-card-bg); border:1px solid var(--sr-card-border); }
  .ev.out .meta { color:var(--sr-accent); }
  .ev.chat { align-items:flex-start; }
  .ev.chat .bubble { background:var(--sr-chip-bg); color:var(--sr-ink-2); }
  .ev.journey, .ev.worker, .ev.thought, .ev.system, .ev.voice { align-items:stretch; margin:0 0 8px; }
  .ev.journey .bubble, .ev.worker .bubble, .ev.thought .bubble, .ev.system .bubble, .ev.voice .bubble {
    max-width:none; background:none; border-left:2px solid var(--sr-muted); border-radius:0; padding:2px 10px; font:12px/1.45 var(--sr-mono); color:var(--sr-ink-2); }
  .ev.journey .bubble, .ev.worker .bubble, .ev.thought .bubble, .ev.system .bubble, .ev.voice .bubble { white-space:normal; }
  .ev.journey .meta, .ev.worker .meta, .ev.thought .meta, .ev.system .meta, .ev.voice .meta { margin-left:12px; }
  .ev.journey .bubble { border-left-color:var(--sr-warn); }
  .ev.worker .bubble { border-left-color:var(--sr-accent); }
  .ev.thought .bubble { font-style:italic; color:var(--sr-muted); }
  .ev.system.alert .bubble { color:var(--sr-danger); border-left-color:var(--sr-danger); }
  .ev.voice .bubble { border-left-color:var(--sr-info); }
  .day { display:flex; align-items:center; gap:10px; color:var(--sr-muted); font:500 10px var(--sr-mono); text-transform:uppercase; letter-spacing:.1em; margin:14px 0 10px; }
  .day::before, .day::after { content:''; flex:1; border-top:1px solid var(--sr-rule); }
  /* Kind filters: which event kinds the feed shows. Off-pills collect an unread count so muted noise is still discoverable. */
  #filters { display:flex; gap:6px; padding:8px 14px 0; overflow-x:auto; scrollbar-width:none; -webkit-overflow-scrolling:touch; }
  #filters::-webkit-scrollbar { display:none; }
  .fpill { display:inline-flex; align-items:center; gap:5px; flex:none; min-height:28px; padding:4px 11px; border-radius:999px;
           background:var(--sr-pill-bg); border:1px solid var(--sr-pill-border); color:var(--sr-muted); font:500 11.5px/1 var(--sr-mono); }
  .fpill.on { color:var(--sr-fg); border-color:var(--sr-fg); }
  .fbadge { background:var(--sr-accent); color:var(--sr-on-accent); border-radius:999px; padding:1px 5px; font-size:9.5px; min-width:16px; text-align:center; font-weight:700; }
  #jump { position:fixed; left:50%; transform:translateX(-50%); bottom:calc(124px + var(--safe-bot)); background:var(--sr-fg); color:var(--sr-bg);
          border:0; border-radius:999px; padding:6px 14px; font:600 12px var(--sr-mono); display:none; z-index:40; }
  #jump.show { display:block; }
  /* Live activity strip: one card per journey/worker heard from recently. */
  #crew { display:none; gap:8px; overflow-x:auto; padding:10px 14px 0; scrollbar-width:none; -webkit-overflow-scrolling:touch; }
  #crew.has { display:flex; }
  #crew::-webkit-scrollbar { display:none; }
  .card { flex:none; width:200px; background:var(--sr-card-bg); border:1px solid var(--sr-card-border); border-radius:var(--sr-radius); padding:9px 10px; font-size:12px; }
  .card .cname { display:flex; align-items:center; gap:7px; font-weight:600; min-width:0; }
  .card .head { flex:none; width:18px; height:18px; display:grid; place-items:center; border:var(--mc-px) solid var(--sr-fg); font:700 10px var(--sr-mono); color:var(--sr-fg); background:var(--sr-chip-bg); }
  .card.worker .head { border-color:var(--sr-accent); color:var(--sr-accent); }
  .card.journey .head { border-color:var(--sr-warn); color:var(--sr-warn); }
  .card .ctitle { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; font-size:12.5px; }
  .card .csub { color:var(--sr-muted); font:500 10.5px var(--sr-mono); margin-top:3px; }
  .card .cline { color:var(--sr-ink-2); margin-top:4px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; line-height:1.4; }
  .card.worker.live { cursor:pointer; }
  .card.worker.live:hover, .card.worker.live:focus-visible { border-color:var(--sr-accent); outline:none; }
  .card.staged { border:var(--mc-px) solid var(--sr-accent); }
  .card .cthumb { display:block; width:100%; aspect-ratio:16/9; object-fit:cover; background:#000; border-radius:4px; margin-top:7px; }
  .card .crow { display:flex; align-items:center; justify-content:space-between; gap:6px; margin-top:7px; }
  .card .cstate { color:var(--sr-muted); font:500 11px var(--sr-mono); }
  .card .cstate.stalled { color:var(--sr-warn); } .card .cstate.working { color:var(--sr-accent); }
  .card .cstop { flex:none; min-width:44px; height:28px; padding:0 10px; border-radius:0; background:var(--sr-danger); color:var(--sr-on-danger);
                 font:800 10.5px var(--sr-mono); letter-spacing:.12em; border:var(--mc-px) solid var(--sr-fg); }
  .card .cstop:disabled { opacity:.6; }
  #chips { display:flex; gap:7px; overflow-x:auto; padding:8px 14px 0; border-top:1px solid var(--sr-rule); -webkit-overflow-scrolling:touch; scrollbar-width:none; }
  #chips::-webkit-scrollbar { display:none; }
  .chip { flex:none; display:inline-flex; align-items:center; min-height:30px; padding:4px 12px; border-radius:999px;
          background:var(--sr-pill-bg); border:1px solid var(--sr-pill-border); color:var(--sr-fg); font-size:12.5px; }
  .chip:active, .chip:hover { border-color:var(--sr-accent); }
  /* the composer: one pill bar, call · text · send */
  form { display:flex; align-items:center; gap:6px; margin:8px 12px; margin-bottom:max(10px, var(--safe-bot));
         padding:4px 4px 4px 6px; background:var(--sr-bg); border:1px solid var(--sr-card-border); border-radius:999px; }
  form:focus-within { border-color:var(--sr-accent); }
  input[type=text] { flex:1; min-width:0; background:transparent; border:0; color:var(--sr-fg); padding:8px 6px; font-size:16px; outline:none; }
  input[type=text]::placeholder { color:var(--sr-muted); }
  #sendBtn { flex:none; height:36px; min-width:36px; padding:0 14px; border-radius:999px; background:var(--sr-accent); color:var(--sr-on-accent); font:600 12.5px var(--sr-mono); }
  #sendBtn:disabled { opacity:.5; }
  /* 📞 the call button: idle → connecting (pulse) → live (green). */
  #callBtn { flex:none; width:36px; height:36px; border-radius:999px; border:1px solid var(--sr-pill-border); background:var(--sr-pill-bg); color:var(--sr-fg); font-size:15px; display:grid; place-items:center; }
  #callBtn.connecting { animation:pulse 1s ease-in-out infinite; }
  #callBtn.live { background:var(--sr-accent); border-color:var(--sr-accent); color:var(--sr-on-accent); width:auto; padding:0 12px; font:600 11.5px var(--sr-mono); }
  #callBtn.live .calldot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--sr-on-accent); margin-right:6px; animation:pulse 1.2s ease-in-out infinite; }
  #toast { position:fixed; left:50%; bottom:calc(84px + var(--safe-bot)); transform:translateX(-50%) translateY(8px); background:var(--sr-bg); color:var(--sr-danger);
           border:1px solid var(--sr-danger); border-radius:999px; padding:8px 14px; font:500 12.5px var(--sr-mono); max-width:86%; opacity:0; pointer-events:none;
           transition:opacity .2s, transform .2s; z-index:60; }
  #toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  #toast.ok { color:var(--sr-fg); border-color:var(--sr-accent); }
  /* Above everything incl. the stage (#stage is positioned and later in the DOM, so without a z-index the black video
     box painted OVER the gate on any viewport wide enough for the 16:9 stage to reach the centre). */
  #gate { position:fixed; inset:0; z-index:100; background:var(--sr-bg); display:grid; place-items:center; padding:20px; overflow-y:auto; }
  #gate.hidden { display:none; }
  .gate-card { width:min(400px, 94vw); background:var(--sr-card-bg); border:1px solid var(--sr-card-border); border-radius:var(--sr-radius); padding:26px 24px; display:flex; flex-direction:column; gap:10px; }
  .gate-card .brand { margin-bottom:8px; } .gate-card .frog { width:28px; height:28px; }
  #gate h1 { font:600 18px/1.3 var(--sr-mono); }
  #gate p { color:var(--sr-ink-2); font-size:13.5px; line-height:1.5; }
  .gate-btn { width:100%; min-height:42px; padding:10px 14px; border-radius:999px; font:600 13px var(--sr-mono); background:var(--sr-accent); color:var(--sr-on-accent); border:1px solid var(--sr-accent); }
  .gate-btn:disabled { opacity:.45; }
  .gate-foot { margin-top:6px; font:10.5px var(--sr-mono); color:var(--sr-muted); display:flex; justify-content:space-between; gap:8px; }
  /* settings drawer: scheme, auth, about — a flat scrim and a 1px rule, like expo */
  #drawer { position:fixed; inset:0; z-index:80; background:var(--sr-scrim); display:flex; justify-content:flex-end; }
  #drawer[hidden] { display:none; }
  .drawer { width:min(380px, 92vw); height:100%; background:var(--sr-bg); border-left:1px solid var(--sr-card-border); display:flex; flex-direction:column; gap:14px;
            padding:calc(12px + var(--safe-top)) 16px calc(16px + var(--safe-bot)); overflow-y:auto; }
  .drawer-head { display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:40px; font:600 13px var(--sr-mono); }
  .lbl { font:600 10.5px var(--sr-mono); text-transform:uppercase; letter-spacing:.08em; color:var(--sr-muted); margin-bottom:6px; }
  .row { display:flex; gap:6px; flex-wrap:wrap; }
  .pill.on { background:var(--sr-accent); border-color:var(--sr-accent); color:var(--sr-on-accent); }
  .note { font-size:12.5px; color:var(--sr-ink-2); line-height:1.55; } .note b { color:var(--sr-fg); }
  .note a { color:var(--sr-accent); }
  kbd { font:11px var(--sr-mono); padding:1px 6px; border:1px solid var(--sr-rule); border-radius:5px; background:var(--sr-chip-bg); }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  #feed:focus-visible, #vchips:focus-visible, #crew:focus-visible, #filters:focus-visible, #chips:focus-visible { outline:2px solid var(--sr-accent); outline-offset:-2px; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation:none !important; transition:none !important; } #xp.busy span { left:0; width:100%; opacity:.5; } }
  /* Phone: #side is invisible to layout, its children stay body's flex items. Crew cards are compact — one line and a
     short strip of the worker's eyes — so the feed keeps its room on an 844px screen. */
  #side { display:contents; }
  @media (max-width: 899px) {
    .card { width:176px; padding:8px 9px; }
    .card .cline { -webkit-line-clamp:1; }
    .card .cthumb { aspect-ratio:3/1; margin-top:6px; }
    .card .crow { margin-top:6px; }
  }
  /* Desktop (≥900px): the cockpit. Topbar strip across; the world on the left, letterboxed to whatever height is there,
     its telemetry card under it; the agent dock on the right as a phone-width column with its own scroll. */
  @media (min-width: 900px) {
    body { display:grid; grid-template-columns:minmax(0,1fr) clamp(360px, 32vw, 460px); grid-template-rows:auto minmax(0,1fr); }
    #top { grid-column:1 / -1; }
    #stage { display:flex; flex-direction:column; min-height:0; padding:12px 0 12px 12px; gap:10px; }
    #eyes { flex:1; min-height:0; display:flex; flex-direction:column; border:1px solid var(--sr-card-border); border-radius:var(--sr-radius); overflow:hidden; }
    #view { flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; }
    #video { flex:1; min-height:0; aspect-ratio:auto; object-fit:contain; }
    #stage:not(.full) #view { cursor:zoom-in; }
    #xp { flex:none; }
    #vitals { flex:none; border:1px solid var(--sr-card-border); border-radius:var(--sr-radius); padding:10px 12px 12px; }
    #hotbar { max-width:none; }
    #side { display:flex; flex-direction:column; min-height:0; position:relative; margin:12px; border:1px solid var(--sr-card-border); border-radius:var(--sr-radius); overflow:hidden; }
    #jump { position:absolute; bottom:120px; }
    #toast { bottom:88px; left:auto; right:16px; transform:translateY(8px); max-width:420px; }
    #toast.show { transform:translateY(0); }
    #feed { padding:12px 16px; }
    .brand .wordmark { height:15px; } .brand .frog { width:24px; height:24px; }
  }
  /* Wide desktop (≥1280px): three zones — eyes · telemetry · agent dock. */
  @media (min-width: 1280px) {
    body { grid-template-columns:minmax(0,1fr) 300px clamp(360px, 28vw, 440px); }
    #stage:not(.full) { display:contents; }
    #eyes { grid-column:1; grid-row:2; margin:12px 0 12px 12px; display:flex; }
    #vitals { grid-column:2; grid-row:2; margin:12px 0 12px 12px; align-self:start; max-height:calc(100% - 24px); overflow-y:auto; }
    #hotbar { grid-template-columns:repeat(9, 1fr); }
    .slot { font-size:9px; } .slot b { font-size:9px; }
    #inv { grid-template-columns:1fr 1fr; }
    #side { grid-column:3; }
  }
</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <symbol id="px-heart" viewBox="0 0 7 7"><path d="M1 0h2v1h1v-1h2v1h1v3h-1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1h-1v-3h1z"/></symbol>
    <symbol id="px-food" viewBox="0 0 7 7"><path d="M4 0h2v1h1v2h-1v1h-1v1h-1v1h-1v1h-1v-1h-1v-1h1v-1h1v-1h1v-1h1z"/></symbol>
    <symbol id="px-armor" viewBox="0 0 7 7"><path d="M0 0h2v1h3v-1h2v4h-1v3h-5v-3h-1z"/></symbol>
  </defs>
</svg>
<div id="gate">
  <div class="gate-card">
    ${BRAND_HTML}
    <h1>StrandsBot \u00b7 live</h1>
    <p id="gateMsg">\u2026</p>
    <button id="gateBtn" class="gate-btn" style="display:none"></button>
    <div class="gate-foot"><span>passkey \u00b7 secure enclave</span><span>strands-minecraft</span></div>
  </div>
</div>
<header id="top">
  ${BRAND_HTML}
  <div id="topright">
    <span id="live" class="pill" role="status"><span id="dot"></span><span id="livetxt">connecting</span></span>
    <button id="schemeBtn" class="icon-btn" type="button" aria-label="Switch between dark and paper" title="dark / paper"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none"/></svg></button>
    <button id="menuBtn" class="icon-btn" type="button" aria-label="Settings" aria-haspopup="dialog" aria-expanded="false"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
  </div>
</header>
<div id="stage" role="region" aria-label="world view">
  <div id="eyes">
  <div id="view">
  <img id="video" alt="">
  <div id="f3" aria-hidden="true">
    <div>
      <div><span class="k">XYZ</span><span id="coords"></span></div>
      <div id="f3where"></div>
      <div id="f3clock"></div>
    </div>
    <div class="r">
      <div id="watchers"></div>
      <div id="f3fps"></div>
    </div>
  </div>
  <div id="vstall" role="status"><span><span class="spin"></span><span id="vtext"></span></span></div>
  <div id="hud">
    <div class="bars">
      <div id="armor" class="bar px" hidden></div>
      <div id="hearts" class="bar px"></div>
      <div id="food" class="bar px"></div>
    </div>
    <div id="hudright">
      <button id="stageback" type="button" aria-label="Back to the bot's own camera">\u2190 bot</button>
      <button id="stopBtn" type="button" aria-label="Stop the bot: halt movement, digging and the journey" title="Stop \u2014 reflex, no model turn">STOP</button>
    </div>
  </div>
  </div>
  <div id="xp" hidden aria-hidden="true"><span></span></div>
  </div>
  <div id="vitals" aria-live="polite" aria-label="bot vitals">
    <div id="vhead">
      <div id="vstate">no telemetry yet</div>
      <button id="invBtn" class="pill" type="button" aria-expanded="false" aria-controls="inv">bag</button>
    </div>
    <div id="vchips" tabindex="0" aria-label="vitals"></div>
    <div id="hotbar" aria-label="hotbar"></div>
    <div id="inv" aria-label="inventory" hidden></div>
  </div>
</div>
<main id="side">
<h1 class="sr">StrandsBot live</h1>
<div id="crew" tabindex="0" aria-label="journeys and workers"></div>
<div id="filters" role="group" tabindex="0" aria-label="feed filters"></div>
<div id="feed" role="log" aria-label="feed" tabindex="0"></div>
<button id="jump" type="button">new messages \u2193</button>
<div id="chips" tabindex="0" aria-label="quick messages"></div>
<form id="composer">
  <button id="callBtn" type="button" data-state="idle" title="voice call" aria-label="voice call">\uD83D\uDCDE</button>
  <input id="msg" type="text" placeholder="tell the bot\u2026" aria-label="message to the bot" autocomplete="off">
  <button id="sendBtn">send</button>
</form>
</main>
<div id="toast" role="status"></div>
<div id="drawer" hidden role="dialog" aria-modal="true" aria-label="settings">
  <div class="drawer">
    <div class="drawer-head"><span>settings</span><button id="drawerClose" class="icon-btn" type="button" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div><div class="lbl">scheme</div><div class="row" id="schemeRow"><button type="button" class="pill" data-scheme="auto">auto</button><button type="button" class="pill" data-scheme="dark">dark</button><button type="button" class="pill" data-scheme="paper">paper</button></div></div>
    <div><div class="lbl">this device</div><p class="note" id="authNote">\u2026</p></div>
    <div><div class="lbl">controls</div><p class="note">Tap the video for fullscreen. <b>STOP</b> is a reflex: it halts the pathfinder, controls, digging and the journey without a model turn. Tap a worker card to put its eyes on the stage.</p></div>
    <div><div class="lbl">about</div><p class="note"><b>strands-minecraft</b> \u2014 a Minecraft bot that is a real Strands agent. <a href="https://github.com/cagataycali/strands-minecraft" target="_blank" rel="noreferrer">github</a></p></div>
  </div>
</div>
<script>
const b64uToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const post = async (url, body) => {
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
};

// iOS Safari only honors navigator.credentials.* inside a FRESH tap gesture —
// any await before it (like fetching the challenge through the tunnel) spends
// the gesture and the ceremony is silently refused. So the challenge is
// prefetched while the gate is on screen, and the tap goes straight to
// Face ID with zero network in between.
async function register(pre) {
  const { key, options } = pre;
  options.challenge = b64uToBuf(options.challenge);
  options.user.id = b64uToBuf(options.user.id);
  (options.excludeCredentials||[]).forEach(c => c.id = b64uToBuf(c.id));
  const cred = await navigator.credentials.create({ publicKey: options });
  await post('/auth/register/finish', { key, label: navigator.platform || 'device', response: {
    id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: bufToB64u(cred.response.clientDataJSON),
      attestationObject: bufToB64u(cred.response.attestationObject),
      transports: cred.response.getTransports ? cred.response.getTransports() : [],
    },
  }});
}

async function login(pre) {
  const { key, options } = pre;
  options.challenge = b64uToBuf(options.challenge);
  (options.allowCredentials||[]).forEach(c => c.id = b64uToBuf(c.id));
  const cred = await navigator.credentials.get({ publicKey: options });
  await post('/auth/login/finish', { key, response: {
    id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: bufToB64u(cred.response.clientDataJSON),
      authenticatorData: bufToB64u(cred.response.authenticatorData),
      signature: bufToB64u(cred.response.signature),
      userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : null,
    },
  }});
}

${veilFor.toString()}
${stopReceipt.toString()}
${mcClock.toString()}
${vitalsModel.toString()}
${systemTone.toString()}
${inventoryModel.toString()}
${crewTitle.toString()}
${stageModel.toString()}
${workerStageState.toString()}
${thumbPlan.toString()}
${displayText.toString()}

const feed = document.getElementById('feed');
const jump = document.getElementById('jump');
const events = [];
let lastDay = '';
const rel = (ts) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
};

// Filters: thoughts + worker chatter are muted by default — they are the
// bot's inner monologue, not the conversation. Choice persists per device.
const KINDS = ['in','out','chat','journey','worker','thought','system','voice'];
const LABELS = { in:'you', out:'bot', chat:'game', journey:'journeys', worker:'workers', thought:'thoughts', system:'sys', voice:'voice' };
let shown;
try { shown = new Set(JSON.parse(localStorage.mcFilters)); } catch { shown = null; }
if (!shown || !shown.size) shown = new Set(['in','out','chat','journey','system','voice']);
const unread = {};
const filtersEl = document.getElementById('filters');

function renderFilters() {
  filtersEl.innerHTML = '';
  for (const k of KINDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fpill' + (shown.has(k) ? ' on' : '');
    b.setAttribute('aria-pressed', shown.has(k) ? 'true' : 'false');
    b.textContent = LABELS[k];
    if (!shown.has(k) && unread[k]) {
      const s = document.createElement('span');
      s.className = 'fbadge';
      s.textContent = unread[k] > 99 ? '99+' : unread[k];
      b.appendChild(s);
    }
    b.onclick = () => {
      shown.has(k) ? shown.delete(k) : shown.add(k);
      if (shown.has(k)) unread[k] = 0;
      localStorage.mcFilters = JSON.stringify([...shown]);
      renderFilters();
      renderFeed();
    };
    filtersEl.appendChild(b);
  }
}

const atBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;

function evNode(ev) {
  const shownText = displayText(ev, shown.has('chat'));
  if (shownText === null) return null; // a duplicate of the chat row
  const div = document.createElement('div');
  div.className = 'ev ' + ev.kind + (ev.kind === 'system' ? ' ' + systemTone(ev.text) : '');
  if (ev.pending) div.classList.add('pending');
  if (ev.replyTo) div.dataset.replyTo = ev.replyTo;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = shownText;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = ev.pending ? 'sending\u2026' : ev.who + ' · ' + rel(ev.ts);
  meta.dataset.ts = ev.ts;
  div.appendChild(bubble);
  div.appendChild(meta);
  return div;
}

function appendEv(ev) {
  const node = evNode(ev);
  if (!node) return;
  const day = new Date(ev.ts).toDateString();
  if (day !== lastDay) {
    lastDay = day;
    const d = document.createElement('div');
    d.className = 'day';
    d.textContent = day === new Date().toDateString() ? 'today'
      : new Date(ev.ts).toLocaleDateString(undefined, { month:'short', day:'numeric' });
    feed.appendChild(d);
  }
  feed.appendChild(node);
  while (feed.children.length > 400) feed.removeChild(feed.firstChild);
}

function renderFeed() {
  feed.innerHTML = '';
  lastDay = '';
  for (const ev of events) if (shown.has(ev.kind)) appendEv(ev);
  feed.scrollTop = feed.scrollHeight;
}

// ── crew strip ──────────────────────────────────────────────────────────
// Journeys and workers announce progress as feed events whose who-field is
// "name #step". Fold those into one card per name — latest line, step
// count — so background work stays visible even with those kinds muted
// in the feed. Cards fade out after 3 minutes of silence.
const crewEl = document.getElementById('crew');
const crew = new Map();

function renderCrew() {
  crewEl.innerHTML = '';
  for (const [name, c] of crew) {
    const card = document.createElement('div');
    const live = c.kind === 'worker' && !!c.id && !c.terminal;
    card.className = 'card ' + c.kind + (live ? ' live' : '') + (c.id && stage.id === c.id ? ' staged' : '');
    const top = document.createElement('div');
    top.className = 'cname';
    const t = crewTitle({ kind: c.kind, name, goal: c.goal, steps: c.steps });
    const head = document.createElement('span'); head.className = 'head'; head.textContent = (name || '?').replace(/^j/, '').slice(0, 1).toUpperCase(); head.setAttribute('aria-hidden', 'true');
    const n = document.createElement('span'); n.className = 'ctitle'; n.textContent = t.title; n.title = t.title;
    top.appendChild(head); top.appendChild(n);
    const sub = document.createElement('div'); sub.className = 'csub'; sub.textContent = t.sub;
    const line = document.createElement('div');
    line.className = 'cline';
    line.textContent = c.line;
    card.appendChild(top); card.appendChild(sub); card.appendChild(line);
    if (live) {
      // The worker's eyes, 1 fps while this tab is visible (refreshThumbs).
      const img = document.createElement('img');
      img.className = 'cthumb'; img.alt = name + "'s view"; img.dataset.id = c.id;
      img.src = thumbCache.get(c.id) || '/api/workers/' + encodeURIComponent(c.id) + '/camera/snapshot?t=' + Date.now();
      card.appendChild(img);
      const row = document.createElement('div'); row.className = 'crow';
      const st = document.createElement('span'); st.className = 'cstate ' + (c.state || ''); st.textContent = c.state || c.kind;
      const stop = document.createElement('button');
      stop.type = 'button'; stop.className = 'cstop'; stop.textContent = 'STOP';
      stop.setAttribute('aria-label', 'Stop ' + name + ': halt its movement and digging');
      stop.addEventListener('click', async (e) => {
        e.stopPropagation();
        stop.disabled = true;
        try { toast(stopReceipt(await post('/api/workers/' + encodeURIComponent(c.id) + '/stop')), 'ok'); }
        catch (err) { toast(stopReceipt({ ok: false, error: err.message })); }
        finally { stop.disabled = false; }
      });
      row.appendChild(st); row.appendChild(stop);
      card.appendChild(row);
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', 'Show ' + name + "'s camera on the stage");
      card.addEventListener('click', () => swapStage(stage.id === c.id ? null : { id: c.id, name }));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); } });
    }
    crewEl.appendChild(card);
  }
  crewEl.classList.toggle('has', crew.size > 0);
}

// Thumbnails: one snapshot per live worker card per second, only while the tab
// is visible — each one is a headless-Chrome screenshot on the server.
const thumbCache = new Map();
function refreshThumbs() {
  const ids = thumbPlan([...crew.values()], document.visibilityState === 'visible');
  for (const id of ids) {
    const img = crewEl.querySelector('.cthumb[data-id="' + id + '"]');
    if (!img) continue;
    const src = '/api/workers/' + encodeURIComponent(id) + '/camera/snapshot?t=' + Date.now();
    img.src = src;
    thumbCache.set(id, src);
  }
  for (const id of [...thumbCache.keys()]) if (ids.indexOf(id) < 0) thumbCache.delete(id);
}
setInterval(refreshThumbs, 1000);

function feedCrew(ev) {
  if (ev.kind !== 'worker' && ev.kind !== 'journey') return;
  if (Date.now() - ev.ts > 180000) return; // SSE backfill: don't resurrect finished work
  const m = /^(.+?) #(\\d+)$/.exec(ev.who || '');
  if (!m) return;
  const prev = crew.get(m[1]);
  crew.set(m[1], { kind: ev.kind, steps: Number(m[2]), line: ev.text, ts: ev.ts, goal: prev && prev.goal, id: ev.workerId || (prev && prev.id), state: prev && prev.state });
  renderCrew();
}

// Authoritative seed from /api/state: a phone opened MID-journey shows the
// work immediately instead of waiting to overhear the next feed event, and
// statuses events never carry (interrupted) get a card too. Events win on
// freshness (they arrive between polls); state wins on existence — it only
// overwrites a card when it knows a NEWER step, and drops cards for work
// the ledgers say is over.
const CREW_MARK = { done: '\u2705 done \u00b7 ', failed: '\u2716 failed \u00b7 ', dismissed: '\u2716 dismissed \u00b7 ', interrupted: '\u26a0 interrupted \u00b7 ' };
function seedCrew(work) {
  if (!work) return;
  const seen = new Set();
  const seed = (name, kind, steps, line, status, goal, id) => {
    seen.add(name);
    const terminal = !!CREW_MARK[status];
    const cur = crew.get(name);
    // A status CHANGE always wins, even at the same step count: a worker that
    // just finished reports ON the step it finished, and that report is the
    // whole point of the card (live soak: the finish used to be invisible).
    if (cur && cur.steps >= steps && !(terminal && !cur.terminal)) { if (goal && !cur.goal) { cur.goal = goal; } if (id && !cur.id) { cur.id = id; } return; } // event feed is ahead
    crew.set(name, {
      kind, steps, terminal, goal: goal || (cur && cur.goal), id: id || (cur && cur.id), state: cur && cur.state,
      line: (CREW_MARK[status] || '') + (line || status),
      // A terminal card keeps its FIRST timestamp so the 3-minute sweeper still
      // retires it: /api/state now holds an outcome for 10 minutes, which must
      // not become a card that never leaves.
      ts: cur && cur.terminal ? cur.ts : Date.now(),
    });
  };
  if (work.journey && (work.journey.status === 'running' || work.journey.status === 'interrupted'))
    seed(work.journey.id, 'journey', work.journey.step, work.journey.last, work.journey.status, work.journey.goal);
  for (const w of work.workers || []) seed(w.name, 'worker', w.steps, w.reason || w.last || w.task, w.status, w.task, w.id);
  for (const [name, c] of [...crew]) {
    // Ledger says this work is over — but let a FRESH card linger: its last
    // line is the terminal report ('done: built the cabin'), worth reading
    // for a moment before the 3-minute sweeper would get it anyway.
    if (!seen.has(name) && Date.now() - c.ts > 90000) crew.delete(name);
  }
  renderCrew();
}

setInterval(() => {
  let dirty = false;
  for (const [name, c] of crew) {
    if (Date.now() - c.ts > 180000) { crew.delete(name); dirty = true; }
  }
  if (dirty) renderCrew();
}, 30000);

function addEv(ev) {
  ev.ts = ev.ts || Date.now();
  if (ev.kind === 'in' && ev.replyTo) settlePending(ev.replyTo);
  feedCrew(ev);
  events.push(ev);
  if (events.length > 500) events.shift();
  if (!shown.has(ev.kind)) {
    unread[ev.kind] = (unread[ev.kind] || 0) + 1;
    renderFilters();
    return;
  }
  const stick = atBottom();
  appendEv(ev);
  if (stick) feed.scrollTop = feed.scrollHeight;
  else jump.classList.add('show');
}

jump.onclick = () => { feed.scrollTop = feed.scrollHeight; jump.classList.remove('show'); };
feed.addEventListener('scroll', () => { if (atBottom()) jump.classList.remove('show'); });
renderFilters();

// Keep relative stamps honest while the tab sits open.
setInterval(() => {
  for (const m of feed.querySelectorAll('.ev:not(.pending) .meta[data-ts]')) {
    const [who] = m.textContent.split(' · ');
    m.textContent = who + ' · ' + rel(Number(m.dataset.ts));
  }
}, 60000);

// Ten pixel sprites per row like the game's HUD: two points per sprite, a half
// point drawn as a shaded sprite. glyph names the <symbol> (px-heart, px-food, px-armor).
function glyphBar(el, count, glyph) {
  const c = Math.max(0, Math.min(20, Math.round(count)));
  const full = Math.floor(c / 2), half = c % 2;
  el.innerHTML = '';
  for (let i = 0; i < 10; i++) {
    const cls = i < full ? 'on' : (i === full && half) ? 'on half' : 'off';
    el.insertAdjacentHTML('beforeend', '<svg class="' + cls + '" aria-hidden="true"><use href="#' + glyph + '"/></svg>');
  }
}

// ── video lifecycle ─────────────────────────────────────────────────────
// The MJPEG <img> gives no per-frame events, so health comes from /api/state:
// the server counts frames it multicast; if that number freezes across two
// polls while we think we're watching, the connection is dead — reload the
// <img> behind a "reconnecting" veil. A hidden tab drops the stream on
// purpose (each watcher costs headless-Chrome screenshots + tunnel bytes).
const video = document.getElementById('video');
const vstall = document.getElementById('vstall');
const vtext = document.getElementById('vtext');
let streaming = false, lastFrames = -1, stillPolls = 0, imgError = false, framesAtStart = null;
let botConnected = null, lastState = null;

function showVeil(v) {
  vstall.classList.toggle('show', v.show);
  vstall.classList.toggle('warn', v.tone === 'warn');
  vstall.classList.toggle('bad', v.tone === 'bad');
  vstall.querySelector('.spin').classList.toggle('off', !v.spin);
  vtext.textContent = v.text;
}

// ── the stage: the bot, or one worker (CREW.md tap-to-swap) ──────────────
let stage = { id: null, name: null };
let workerRows = new Map(); // id → row from GET /api/workers (polled while a worker is on stage)
const stageback = document.getElementById('stageback');
function swapStage(next) {
  stage = next || { id: null, name: null };
  const m = stageModel(stage, (lastState && lastState.username) || 'StrandsBot');
  stopBtn.setAttribute('aria-label', m.stopAria);
  stageback.classList.toggle('show', m.worker);
  lastFrames = -1;
  if (streaming) startStream();
  renderCrew();
  pollWorkers();
}
stageback.addEventListener('click', (e) => { e.stopPropagation(); swapStage(null); });
// Runs while a worker is on stage OR a live worker card is showing: the rows
// carry the state word, the frames counter and — between the SSE 'done' line
// and the next /api/state seed — the fact that a worker is already dead, so its
// card stops asking for thumbnails the moment it leaves.
async function pollWorkers() {
  if (!stage.id && !thumbPlan([...crew.values()], true).length) return;
  try {
    const j = await (await fetch('/api/workers')).json();
    workerRows = new Map((j.workers || []).map((r) => [r.id, r]));
    for (const c of crew.values()) {
      if (!c.id) continue;
      const row = workerRows.get(c.id);
      if (!row) continue;
      c.state = row.state;
      if (row.state === 'dead') c.terminal = true;
    }
    renderCrew();
  } catch { /* the state poll reports unreachability */ }
}
setInterval(pollWorkers, 2000);

function startStream() {
  streaming = true;
  stillPolls = 0;
  imgError = false;
  framesAtStart = null;
  video.src = stageModel(stage, '').src + '?t=' + Date.now();
  showVeil(veilFor({ noFrameYet: true })); // until the first poll says otherwise
}
function stopStream() {
  streaming = false;
  video.removeAttribute('src');
}
video.addEventListener('error', () => { if (streaming) { imgError = true; showVeil(veilFor({ connected: botConnected, camera: lastState && lastState.camera, imgError: true })); } });

document.addEventListener('visibilitychange', () => {
  if (!connected) return;
  if (document.visibilityState === 'hidden') stopStream();
  else startStream();
});

function paintDot() {
  const dot = document.getElementById('dot');
  dot.classList.toggle('ok', sseOpen && botConnected !== false);
  dot.classList.toggle('warn', sseOpen && botConnected === false);
  dot.title = !sseOpen ? 'feed disconnected' : botConnected === false ? 'bot is not in the world' : 'live';
  const live = document.getElementById('live');
  live.classList.toggle('ok', sseOpen && botConnected !== false);
  document.getElementById('livetxt').textContent = !sseOpen ? 'offline' : botConnected === false ? 'not in world' : 'live';
}

// F3 line: frames per second from the server's counter between two polls, and
// the detector's own words when the picture is stale (byte-identical while the body moved).
let fpsAt = 0, fpsFrames = null;
function paintFps(frames, camera) {
  const now = Date.now();
  let fps = null;
  if (typeof frames === 'number' && fpsFrames !== null && now > fpsAt) fps = Math.max(0, (frames - fpsFrames) / ((now - fpsAt) / 1000));
  if (typeof frames === 'number') { fpsFrames = frames; fpsAt = now; }
  const stale = /stale/.test(camera || '');
  document.getElementById('view').classList.toggle('stale', stale);
  document.getElementById('f3fps').innerHTML = (fps === null ? '\\u2014' : fps.toFixed(1)) + ' fps' + (stale ? '<span class="tag stale">STALE</span>' : '');
}

async function pollState() {
  let s;
  try { s = await (await fetch('/api/state')).json(); }
  catch {
    // state unreachable = tunnel or dashboard gone; say so, don't blame the stream
    if (streaming) showVeil(veilFor({ unreachable: true }));
    return;
  }
  lastState = s;
  botConnected = typeof s.connected === 'boolean' ? s.connected : null;
  paintDot();
  glyphBar(document.getElementById('hearts'), s.health ?? 0, 'px-heart');
  glyphBar(document.getElementById('food'), s.food ?? 0, 'px-food');
  document.getElementById('coords').textContent = s.position
    ? Math.round(s.position.x) + ' ' + Math.round(s.position.y) + ' ' + Math.round(s.position.z) : '';
  seedCrew(s.work);
  // On a worker's stage the worker's row stands in for the bot's state: its
  // frames counter, its camera sentence, its liveness. Gone/dead → back to the bot.
  let frames = s.frames, camera = s.camera, connected = botConnected, watching = s.watchers ?? 0, label = s.username ?? '';
  if (stage.id) {
    const ws = workerStageState(workerRows.get(stage.id));
    if (ws.gone && workerRows.size) { toast((stage.name || stage.id) + ' is gone \\u2014 back to ' + (s.username || 'the bot')); swapStage(null); }
    else { frames = ws.frames; camera = ws.camera; connected = ws.connected; label = stageModel(stage, '').label; watching = (workerRows.get(stage.id) || {}).camera && workerRows.get(stage.id).camera.watchers || 0; }
  }
  document.getElementById('watchers').textContent =
    watching + ' watching \\u00b7 ' + label + (connected === false ? ' \\u00b7 offline' : '');
  paintFps(frames, camera);
  if (streaming && document.visibilityState === 'visible') {
    let stalled = false;
    if (framesAtStart === null) framesAtStart = frames;
    const noFrameYet = typeof frames === 'number' && frames === framesAtStart;
    if (typeof frames === 'number' && frames === lastFrames) {
      // Frozen counter while warming is the warm-up, not a stall — reload only
      // once the camera claims to be streaming and still sends nothing.
      const warming = (camera || '').indexOf('warming') === 0;
      if (++stillPolls >= 2 && !warming) { stalled = true; startStream(); }
    } else {
      stillPolls = 0;
    }
    lastFrames = frames;
    showVeil(veilFor({ connected: connected, camera: camera, stalled, imgError, noFrameYet }));
  }
}

let sseOpen = false;

// ── vitals ───────────────────────────────────────────────────────────────
const vitalsEl = document.getElementById('vitals');
let lastTelemetry = null, telemetryAt = 0;
function paintVitals() {
  const v = vitalsModel(lastTelemetry, Date.now());
  // stale = the SAMPLE is old (server clock) or our last successful fetch is
  vitalsEl.classList.toggle('stale', v.stale || Date.now() - telemetryAt > 15000);
  document.getElementById('vstate').textContent = v.state;
  // the F3 lines the chips already know: dimension/biome and the clock
  const t = lastTelemetry || {};
  const where = t.dimension ? String(t.dimension).replace(/^minecraft:/, '') + (t.biome ? ' / ' + String(t.biome).replace(/_/g, ' ') : '') : '';
  document.getElementById('f3where').textContent = where;
  if (t.time) { const c = mcClock(t.time.ticks || 0); document.getElementById('f3clock').textContent = 'day ' + t.time.day + ' \\u00b7 ' + c.hhmm + ' ' + (c.part === 'night' ? '\\u263D' : c.part === 'day' ? '\\u2600' : '\\u25D1') + (t.weather && t.weather !== 'clear' ? ' \\u00b7 ' + t.weather : ''); }
  else document.getElementById('f3clock').textContent = '';
  // XP bar: a task in flight is the thin green line; idle hides it
  const xp = document.getElementById('xp');
  const busy = !!(t.task && t.task.kind && t.task.kind !== 'idle');
  xp.hidden = !busy; xp.classList.toggle('busy', busy);
  const box = document.getElementById('vchips');
  box.innerHTML = '';
  for (const c of v.chips) {
    const el = document.createElement('span');
    el.className = 'vchip' + (c.tone ? ' ' + c.tone : '');
    const k = document.createElement('b'); k.textContent = c.k;
    el.appendChild(k); el.appendChild(document.createTextNode(c.v));
    box.appendChild(el);
  }
}
const invEl = document.getElementById('inv');
const invBtn = document.getElementById('invBtn');
let invOpen = localStorage.mcInv ? localStorage.mcInv === '1' : matchMedia('(min-width: 900px)').matches;
function paintInv() {
  invBtn.setAttribute('aria-expanded', invOpen ? 'true' : 'false');
  invEl.hidden = !invOpen;
  const inv = inventoryModel(lastTelemetry && lastTelemetry.inventory, lastTelemetry && lastTelemetry.held);
  invBtn.textContent = inv.stacks ? inv.stacks + ' stacks \u00b7 ' + inv.total : 'bag';
  // the hotbar: the first nine stacks (held first), a two-letter mark + count per slot
  const hb = document.getElementById('hotbar');
  hb.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const r = inv.rows[i];
    const el = document.createElement('div');
    el.className = 'slot' + (r ? (r.held ? ' held' : '') : ' blank');
    if (r) {
      el.title = r.label + ' \u00d7 ' + r.count + (r.held ? ' (in hand)' : '');
      const ab = document.createElement('span'); ab.className = 'ab'; var words = r.label.split(' '); ab.textContent = words.length > 1 ? words.map(function (w) { return w[0]; }).join('').slice(0, 2) : r.label.slice(0, 2);
      const c = document.createElement('b'); c.textContent = r.count;
      el.appendChild(ab); el.appendChild(c);
    }
    hb.appendChild(el);
  }
  if (!invOpen) return;
  invEl.innerHTML = '';
  if (!inv.rows.length) {
    const e = document.createElement('div'); e.className = 'row empty'; e.textContent = lastTelemetry ? 'empty hands, empty bag' : 'no telemetry yet';
    invEl.appendChild(e); return;
  }
  for (const r of inv.rows) {
    const el = document.createElement('div'); el.className = 'row' + (r.held ? ' held' : '');
    el.title = r.label + (r.held ? ' (in hand)' : '');
    const n = document.createElement('span'); n.textContent = (r.held ? '\u270B ' : '') + r.label;
    const c = document.createElement('b'); c.textContent = r.count;
    el.appendChild(n); el.appendChild(c); invEl.appendChild(el);
  }
}
invBtn.addEventListener('click', (e) => { e.stopPropagation(); invOpen = !invOpen; localStorage.mcInv = invOpen ? '1' : '0'; paintInv(); });

async function pollTelemetry() {
  try {
    lastTelemetry = await (await fetch('/api/telemetry')).json();
    telemetryAt = Date.now();
  } catch { /* stale marker takes over after 15 s */ }
  paintVitals();
  paintInv();
}
vitalsEl.addEventListener('click', (e) => e.stopPropagation()); // not a fullscreen tap
let connected = false;
function connect() {
  connected = true;
  startStream();
  const es = new EventSource('/events');
  es.onopen = () => { sseOpen = true; paintDot(); };
  es.onerror = () => { sseOpen = false; paintDot(); };
  es.onmessage = (m) => addEv(JSON.parse(m.data));
  pollState();
  pollTelemetry();
  setInterval(pollState, 5000);
  setInterval(pollTelemetry, 5000);
}

// Tap the video for a fullscreen takeover (CSS, not the Fullscreen API —
// iOS Safari refuses requestFullscreen on anything but <video>).
document.getElementById('stage').addEventListener('click', () => {
  document.getElementById('stage').classList.toggle('full');
});

let toastTimer;
function toast(text, tone) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.toggle('ok', tone === 'ok');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// One send path for the form and the chips: pending state on the button,
// failures go to a toast — the feed stays a conversation, not an error log.
// Optimistic echo: the bubble appears at the tap, dimmed and 'sending…', and
// the server's own 'in' event (tagged replyTo = say id) replaces it. Through
// the tunnel that gap was ~300 ms of nothing after pressing send.
const pendingSends = new Map(); // local id → node
function settlePending(sayId) {
  const node = pendingSends.get(sayId);
  if (node) { node.remove(); pendingSends.delete(sayId); }
}
async function send(text) {
  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  btn.textContent = '…';
  const localId = 'p' + Date.now();
  const stick = atBottom();
  const node = evNode({ kind: 'in', who: 'you', text, ts: Date.now(), pending: true });
  feed.appendChild(node);
  pendingSends.set(localId, node);
  if (stick) feed.scrollTop = feed.scrollHeight;
  try {
    const r = await post('/api/say', { text });
    // re-key under the server's id so the SSE 'in' can settle it; if the
    // event already arrived (fast local), settle now.
    pendingSends.delete(localId);
    if (feed.querySelector('.ev.in:not(.pending)[data-reply-to="' + r.id + '"]')) node.remove();
    else pendingSends.set(r.id, node);
  } catch (err) {
    node.remove(); pendingSends.delete(localId);
    toast('send failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'send';
  }
}

const CHIPS = ['status?', 'come to me', 'what are you doing?', 'look around', 'follow me'];

// 🛑 the reflex stop. A chip saying "stop" was a MODEL turn — seconds of
// thinking while the body kept walking off the cliff. This is the body-level
// halt (web.ts stopBody + the journey), answered in milliseconds.
const stopBtn = document.getElementById('stopBtn');
stopBtn.addEventListener('click', async (e) => {
  e.stopPropagation(); // the stage tap toggles fullscreen; this is not that tap
  stopBtn.disabled = true; stopBtn.classList.add('busy');
  try { toast(stopReceipt(await post(stageModel(stage, '').stopPath)), 'ok'); }
  catch (err) { toast(stopReceipt({ ok: false, error: err.message })); }
  finally { stopBtn.disabled = false; stopBtn.classList.remove('busy'); }
});
const chipsEl = document.getElementById('chips');
for (const c of CHIPS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = c;
  b.onclick = () => send(c);
  chipsEl.appendChild(b);
}

document.getElementById('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('msg');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  send(text);
});

// ── scheme + settings drawer ────────────────────────────────────────────────
// html[data-scheme] was set before paint by the head script; this is the toggle.
function setScheme(s) {
  if (s === 'auto') { try { localStorage.removeItem('mc-scheme'); } catch (e) { /* private mode */ } }
  else { try { localStorage['mc-scheme'] = s; } catch (e) { /* private mode */ } }
  const eff = s === 'auto' ? (matchMedia('(max-width: 899px)').matches || matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'paper') : s;
  document.documentElement.dataset.scheme = eff;
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = eff === 'dark' ? '#000000' : '#ffffff';
  let stored = null; try { stored = localStorage['mc-scheme']; } catch (e) { /* private mode */ }
  for (const b of document.querySelectorAll('#schemeRow .pill')) b.classList.toggle('on', b.dataset.scheme === (stored || 'auto'));
}
document.getElementById('schemeBtn').addEventListener('click', () => setScheme(document.documentElement.dataset.scheme === 'dark' ? 'paper' : 'dark'));
for (const b of document.querySelectorAll('#schemeRow .pill')) b.addEventListener('click', () => setScheme(b.dataset.scheme));
setScheme((() => { try { return localStorage['mc-scheme'] || 'auto'; } catch (e) { return 'auto'; } })());
const drawer = document.getElementById('drawer');
const menuBtn = document.getElementById('menuBtn');
function openDrawer(v) { drawer.hidden = !v; menuBtn.setAttribute('aria-expanded', v ? 'true' : 'false'); if (v) document.getElementById('drawerClose').focus(); else menuBtn.focus(); }
menuBtn.addEventListener('click', () => openDrawer(true));
document.getElementById('drawerClose').addEventListener('click', () => openDrawer(false));
drawer.addEventListener('click', (e) => { if (e.target === drawer) openDrawer(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden) openDrawer(false); });

// ── 📞 voice call: this phone is the bot's mic and speaker ──────────────────
// getUserMedia (echoCancellation:true = the phone's OS-level AEC, so half
// duplex is NOT needed on this path) → AudioWorklet captures PCM and
// decimates contextRate→24k → binary WS frames to /voice → server audio
// comes back as 24k PCM16, wrapped in AudioBuffers (the AudioContext
// resamples to its own rate on playback). A flush control frame stops every
// queued buffer — the browser half of barge-in.
// iOS rules honored here: the AudioContext is created INSIDE the tap, and
// visibilitychange resumes it after backgrounding.
const CALL_RATE = 24000;
const callBtn = document.getElementById('callBtn');
let vc = null; // the live call: { ws, ac, stream, playHead, sources }

function setCallState(s) {
  callBtn.dataset.state = s;
  callBtn.classList.toggle('live', s === 'live');
  callBtn.classList.toggle('connecting', s === 'connecting');
  if (s === 'live') callBtn.innerHTML = '<span class="calldot"></span>end';
  else callBtn.textContent = s === 'connecting' ? '…' : '📞';
}

// The capture worklet, shipped as a blob module. One long line on purpose:
// a raw newline inside this quoted string would be a syntax error in the
// served page. Nearest-sample decimation is plenty for speech (48k or
// 44.1k context rate → 24k wire rate).
const CAP_WORKLET =
  'class Cap extends AudioWorkletProcessor { constructor() { super(); this.acc = 0; this.buf = []; } ' +
  'process(inputs) { const ch = inputs[0] && inputs[0][0]; if (!ch) return true; ' +
  'const ratio = sampleRate / 24000; ' +
  'for (let i = 0; i < ch.length; i++) { this.acc += 1; if (this.acc >= ratio) { this.acc -= ratio; ' +
  'const s = Math.max(-1, Math.min(1, ch[i])); this.buf.push(s < 0 ? s * 32768 : s * 32767); } } ' +
  'if (this.buf.length >= 960) { const out = new Int16Array(this.buf); ' +
  'this.port.postMessage(out.buffer, [out.buffer]); this.buf = []; } return true; } } ' +
  'registerProcessor("cap", Cap);';
let capUrl = null;
function workletUrl() {
  if (!capUrl) capUrl = URL.createObjectURL(new Blob([CAP_WORKLET], { type: 'application/javascript' }));
  return capUrl;
}

function playChunk(v, ab) {
  const i16 = new Int16Array(ab);
  if (!i16.length) return;
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  const buf = v.ac.createBuffer(1, f32.length, CALL_RATE);
  buf.getChannelData(0).set(f32);
  const src = v.ac.createBufferSource();
  src.buffer = buf;
  src.connect(v.ac.destination);
  // Gapless queue: each chunk starts where the previous one ends.
  const t = Math.max(v.ac.currentTime + 0.02, v.playHead);
  src.start(t);
  v.playHead = t + buf.duration;
  v.sources.add(src);
  src.onended = () => v.sources.delete(src);
}

function flushPlay(v) {
  // Barge-in: queued audio must NOT play. Buffers already scheduled are the
  // browser's ffplay — stop them all and restart the queue head.
  for (const s of v.sources) { try { s.stop(); } catch (e) { /* ended */ } }
  v.sources.clear();
  v.playHead = 0;
}

function endCall(sendStop) {
  const v = vc;
  vc = null;
  setCallState('idle');
  if (!v) return;
  try { if (sendStop && v.ws && v.ws.readyState === 1) v.ws.send(JSON.stringify({ type: 'stop' })); } catch (e) { /* gone */ }
  try { if (v.ws) v.ws.close(); } catch (e) { /* gone */ }
  try { if (v.stream) v.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* gone */ }
  try { if (v.ac) v.ac.close(); } catch (e) { /* gone */ }
}

async function beginCall() {
  setCallState('connecting');
  let stream = null, ac = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    ac = new (window.AudioContext || window.webkitAudioContext)();
    await ac.audioWorklet.addModule(workletUrl());
  } catch (err) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ac) ac.close();
    toast('mic: ' + err.message);
    setCallState('idle');
    return;
  }
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/voice');
  ws.binaryType = 'arraybuffer';
  const v = { ws, ac, stream, playHead: 0, sources: new Set() };
  vc = v;
  const node = new AudioWorkletNode(ac, 'cap');
  ac.createMediaStreamSource(stream).connect(node);
  // Keep the graph pulled without hearing ourselves: worklet → muted gain.
  const sink = ac.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(ac.destination);
  node.port.onmessage = (ev) => { if (vc === v && ws.readyState === 1) ws.send(ev.data); };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'start' }));
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') { playChunk(v, ev.data); return; }
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'status') {
      if (m.status === 'live') setCallState('live');
      else if (m.status === 'ended' || m.status === 'error') { if (vc === v) endCall(false); }
    } else if (m.type === 'flush') flushPlay(v);
    else if (m.type === 'busy') { toast('another device is on the call'); if (vc === v) endCall(false); }
    else if (m.type === 'error') toast('call: ' + m.error);
  };
  ws.onclose = () => { if (vc === v) endCall(false); };
  ws.onerror = () => { if (vc === v) { toast('call connection failed'); endCall(false); } };
}

callBtn.addEventListener('click', () => { if (vc) endCall(true); else beginCall(); });
document.addEventListener('visibilitychange', () => {
  // iOS suspends the AudioContext when the tab backgrounds; resume on return.
  if (!document.hidden && vc && vc.ac && vc.ac.state === 'suspended') vc.ac.resume();
});

(async () => {
  const gate = document.getElementById('gate');
  const msg = document.getElementById('gateMsg');
  const btn = document.getElementById('gateBtn');
  // The very first fetch a phone makes, over a tunnel that may not be warm
  // yet: one failure used to throw out of this IIFE, so the gate sat there
  // with no message, no button and no retry until the user reloaded. Retry
  // with backoff instead, and say what is happening.
  const status = async () => {
    for (let i = 0; ; i++) {
      try { return await (await fetch('/auth/status')).json(); }
      catch (e) {
        if (i >= 4) throw e;
        msg.textContent = 'Reaching the bot\u2026 (' + (i + 1) + ')';
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, i)));
      }
    }
  };
  let s;
  try { s = await status(); }
  catch { msg.textContent = 'Cannot reach the bot \u2014 check the tunnel, then reload.'; return; }
  document.getElementById('authNote').textContent = !s.enabled ? 'Passkeys are off on this rail (dev bypass or token auth).'
    : s.enrolled ? 'Unlocked with the admin passkey \\u2014 it lives in this device\\u2019s secure enclave; the session cookie lasts a day.'
    : 'No passkey enrolled yet.';
  const enter = () => { gate.classList.add('hidden'); connect(); };
  if (!s.enabled || s.authed) return enter();
  // Prefetch the ceremony BEFORE the tap (see note above register). The
  // challenge lives 5 minutes server-side; refresh it every 4 so a gate
  // left open doesn't go stale.
  let pre = null;
  const beginUrl = s.enrolled ? '/auth/login/begin' : '/auth/register/begin';
  const prefetch = async () => { try { pre = await post(beginUrl, {}); } catch (e) { pre = null; msg.textContent = e.message; } };
  await prefetch();
  setInterval(prefetch, 240000);
  btn.style.display = '';
  const go = async () => {
    if (!pre) { await prefetch(); if (!pre) return; }
    const p = pre; pre = null; // a challenge is single-use either way
    btn.disabled = true;
    try {
      await (s.enrolled ? login(p) : register(p));
      enter();
    } catch (e) {
      msg.textContent = (e.name === 'NotAllowedError')
        ? 'Face ID was cancelled or timed out \\u2014 tap to try again.'
        : e.message;
      void prefetch();
    } finally { btn.disabled = false; }
  };
  if (!s.enrolled) {
    msg.textContent = 'First visit: create the admin passkey. It lives in this device\\u2019s secure enclave \\u2014 Face ID is the login from now on.';
    btn.textContent = 'Create passkey';
  } else {
    msg.textContent = 'Locked. Unlock with your passkey.';
    btn.textContent = 'Unlock with Face ID';
  }
  btn.onclick = go;
})();
</script>
</body>
</html>`;
