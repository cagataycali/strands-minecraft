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
import { stopReceipt, mcClock, vitalsModel, systemTone, inventoryModel, crewTitle, displayText, stageModel, workerStageState, thumbPlan } from './hud.js';

export const PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="StrandsBot">
<meta name="theme-color" content="#0b0e14">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png">
<title>StrandsBot · live</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background:#0b0e14; color:#dce3ea; font:15px/1.45 -apple-system,system-ui,sans-serif;
         display:flex; flex-direction:column; height:100dvh; }
  /* The video IS the header: vitals live on it, tap toggles fullscreen. */
  #stage { padding-top:env(safe-area-inset-top); background:#000; }
  #view { position:relative; } /* the HUD and the veil anchor to the VIDEO, not the strip below it */
  #video { width:100%; aspect-ratio:16/9; background:#000; object-fit:cover; display:block; }
  #stage.full { position:fixed; inset:0; z-index:50; display:flex; flex-direction:column;
                justify-content:center; padding-top:0; }
  #stage.full #view { flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; }
  #stage.full #video { aspect-ratio:auto; height:100%; min-height:0; object-fit:contain; }
  #hud { position:absolute; left:0; right:0; bottom:0; padding:26px 12px 8px;
         background:linear-gradient(transparent, rgba(0,0,0,.75));
         display:flex; align-items:flex-end; gap:12px; pointer-events:none;
         font-size:12px; font-variant-numeric:tabular-nums; color:#dce3ea;
         text-shadow:0 1px 2px rgba(0,0,0,.8); }
  #dot { width:8px; height:8px; border-radius:50%; background:#e5534b; margin-bottom:4px; flex:none; }
  #dot.ok { background:#3fb950; } #dot.warn { background:#e3b341; }
  .bar { letter-spacing:1px; font-size:13px; line-height:1.2; }
  #hearts .on { color:#ff5a52; } #food .on { color:#d29922; }
  .bar .off { color:rgba(255,255,255,.25); }
  #food span { font-size:11px; }
  #food .off { filter:grayscale(1); opacity:.3; }
  #hudright { margin-left:auto; text-align:right; color:#aeb8c2; white-space:nowrap; }
  /* The one control on the stage. Reflex-level: POST /api/stop halts the
     pathfinder, controls, digging and the journey without buying a model turn.
     Red first, like the tiny body card; big enough for a thumb (44px). */
  #stopBtn { pointer-events:auto; flex:none; min-width:64px; height:44px; padding:0 14px;
             border-radius:12px; background:#b62324; color:#fff; font-weight:800; font-size:14px;
             letter-spacing:1px; border:1px solid #ff7b72; box-shadow:0 2px 10px rgba(0,0,0,.6);
             text-shadow:none; margin-bottom:2px; }
  #stopBtn:active, #stopBtn.busy { background:#e5534b; }
  #stopBtn:disabled { opacity:.6; }
  /* Vitals strip under the video — the body card's state line + chips from
     /api/telemetry (time, weather, where, xp, air, held, hostiles, players).
     Mono numbers; a stale sample is dimmed and says so. */
  #vitals { background:#0b0e14; border-top:1px solid #1c2230; padding:7px 14px 8px; font-size:12px;
            display:flex; flex-direction:column; gap:5px; cursor:default; }
  #vitals.stale { opacity:.55; }
  #vstate { color:#dce3ea; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #vstate::before { content:'\u25B8 '; color:#58a6ff; }
  #vitals.stale #vstate::after { content:' \u00b7 stale'; color:#e3b341; font-weight:400; }
  #vchips { display:flex; gap:6px; overflow-x:auto; scrollbar-width:none; -webkit-overflow-scrolling:touch; }
  #vchips::-webkit-scrollbar { display:none; }
  .vchip { flex:none; border:1px solid #2a3242; border-radius:8px; padding:2px 8px; color:#aeb8c2;
           font-variant-numeric:tabular-nums; font-feature-settings:'tnum'; }
  .vchip b { color:#8b98a5; font-weight:500; margin-right:5px; text-transform:uppercase; font-size:10px; letter-spacing:.5px; }
  .vchip.warn { border-color:#5a4a1a; color:#e3b341; } .vchip.bad { border-color:#6e2c31; color:#ff7b72; }
  #stage.full #vitals { display:none; }
  #vitals { position:relative; }
  #invBtn { position:absolute; right:10px; top:5px; background:none; border:1px solid #2a3242; color:#aeb8c2;
            border-radius:8px; padding:3px 9px; font-size:11px; font-weight:600; min-height:24px; }
  #invBtn[aria-expanded="true"] { background:#1c2230; color:#dce3ea; }
  #inv { display:grid; grid-template-columns:repeat(auto-fill, minmax(96px, 1fr)); gap:4px; padding-top:4px; }
  #inv[hidden] { display:none; }
  .slot { display:flex; justify-content:space-between; gap:6px; background:#10141c; border:1px solid #1c2230;
          border-radius:6px; padding:3px 7px; font-size:11px; color:#aeb8c2; white-space:nowrap; overflow:hidden; }
  .slot span { overflow:hidden; text-overflow:ellipsis; }
  .slot b { color:#dce3ea; font-variant-numeric:tabular-nums; }
  .slot.held { border-color:#1f6feb; color:#dce3ea; }
  .slot.empty { grid-column:1/-1; color:#8b98a5; justify-content:center; }
  #vstall { position:absolute; inset:0; display:none; align-items:center; justify-content:center;
            background:rgba(11,14,20,.55); color:#aeb8c2; font-size:13px; letter-spacing:.3px;
            backdrop-filter:blur(2px); -webkit-backdrop-filter:blur(2px); }
  #vstall.show { display:flex; }
  #vstall span { display:flex; align-items:center; gap:8px; }
  #vstall.warn { color:#e3b341; } #vstall.bad { color:#ff7b72; }
  #vstall .spin.off { display:none; }
  .spin { width:14px; height:14px; border:2px solid #2a3242; border-top-color:#58a6ff;
          border-radius:50%; animation:spin 1s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation:none; } }
  #feed { flex:1; overflow-y:auto; padding:10px 14px; -webkit-overflow-scrolling:touch; }
  /* Chat-style feed: my messages right, the bot's left, everything else quiet rows. */
  .ev { display:flex; flex-direction:column; margin:0 0 8px; word-wrap:break-word; }
  .ev .bubble { max-width:82%; padding:8px 12px; border-radius:16px; white-space:pre-wrap; }
  .ev .meta { font-size:11px; color:#8b98a5; margin:2px 6px 0; }
  .ev.in { align-items:flex-end; }
  .ev.in .bubble { background:#1f6feb; color:#fff; border-bottom-right-radius:4px; }
  .ev.in.pending .bubble { opacity:.6; }
  .ev.out { align-items:flex-start; }
  .ev.out .bubble { background:#1c2230; border-bottom-left-radius:4px; }
  .ev.chat { align-items:flex-start; }
  .ev.chat .bubble { background:#16121c; border:1px solid #2a2236; border-bottom-left-radius:4px; }
  .ev.chat .meta { color:#f778ba; }
  .ev.journey, .ev.worker, .ev.thought, .ev.system, .ev.voice { align-items:center; }
  .ev.journey .bubble, .ev.worker .bubble, .ev.thought .bubble, .ev.system .bubble, .ev.voice .bubble {
    background:none; font-size:12px; color:#8b98a5; text-align:center; padding:2px 10px; }
  .ev.journey .bubble { color:#d29922; }
  .ev.worker .bubble { color:#bc8cff; }
  .ev.thought .bubble { font-style:italic; }
  .ev.system .bubble { color:#9aa5b1; }
  .ev.system.alert .bubble { color:#ff7b72; }
  .ev.voice .bubble { color:#58c6ff; }
  .day { display:flex; align-items:center; gap:10px; color:#8b98a5; font-size:11px; margin:14px 0 10px; }
  .day::before, .day::after { content:''; flex:1; border-top:1px solid #1c2230; }
  /* Kind filters: which event kinds the feed shows. Off-pills collect an
     unread count so muted noise is still discoverable. */
  #filters { display:flex; gap:6px; padding:8px 14px 0; overflow-x:auto; scrollbar-width:none;
             -webkit-overflow-scrolling:touch; }
  #filters::-webkit-scrollbar { display:none; }
  .fpill { display:flex; align-items:center; gap:5px; background:none; border:1px solid #2a3242;
           color:#8b98a5; border-radius:12px; padding:5px 11px; font-size:12px; flex:none; min-height:28px; }
  .fpill.on { color:#dce3ea; background:#1c2230; }
  .fbadge { background:#1f6feb; color:#fff; border-radius:8px; padding:0 5px; font-size:10px;
            min-width:16px; text-align:center; }
  #jump { position:fixed; left:50%; transform:translateX(-50%);
          bottom:calc(120px + env(safe-area-inset-bottom)); background:#1f6feb; color:#fff;
          border:0; border-radius:14px; padding:6px 14px; font-size:13px; font-weight:600;
          box-shadow:0 2px 10px rgba(0,0,0,.5); display:none; z-index:40; }
  #jump.show { display:block; }
  /* Live activity strip: one card per journey/worker heard from recently. */
  #crew { display:none; gap:8px; overflow-x:auto; padding:8px 14px 0; scrollbar-width:none;
          -webkit-overflow-scrolling:touch; }
  #crew.has { display:flex; }
  #crew::-webkit-scrollbar { display:none; }
  .card { flex:none; width:190px; background:#10141c; border:1px solid #2a3242; border-radius:10px;
          padding:7px 10px; font-size:12px; }
  .card .cname { font-weight:600; display:flex; justify-content:space-between; gap:6px; }
  .card.worker .cname { color:#bc8cff; }
  .card.journey .cname { color:#d29922; }
  .card .csteps { color:#8b98a5; font-weight:400; }
  .card .cline { color:#8b98a5; margin-top:2px; overflow:hidden; display:-webkit-box;
                 -webkit-line-clamp:2; -webkit-box-orient:vertical; }
  .card .ctitle { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
  .card .csub { color:#8b98a5; font-size:11px; font-weight:400; margin-top:1px; }
  /* Worker cards are BODIES (CREW.md): a live thumbnail from the worker's own
     eyes, its own reflex STOP, and a tap swaps the stage to its stream. */
  .card.worker.live { cursor:pointer; }
  .card.worker.live:hover, .card.worker.live:focus-visible { border-color:#bc8cff; outline:none; }
  .card.staged { border-color:#bc8cff; box-shadow:0 0 0 1px #bc8cff inset; }
  .card .cthumb { display:block; width:100%; aspect-ratio:16/9; object-fit:cover; background:#000;
                  border-radius:6px; margin-top:6px; }
  .card .crow { display:flex; align-items:center; justify-content:space-between; gap:6px; margin-top:6px; }
  .card .cstate { color:#8b98a5; font-size:11px; }
  .card .cstate.stalled { color:#e3b341; } .card .cstate.working { color:#3fb950; }
  .card .cstop { flex:none; min-width:44px; height:28px; padding:0 10px; border-radius:8px; background:#b62324;
                 color:#fff; font-weight:800; font-size:11px; letter-spacing:1px; border:1px solid #ff7b72; }
  .card .cstop:disabled { opacity:.6; }
  #stageback { pointer-events:auto; display:none; flex:none; height:44px; padding:0 12px; border-radius:12px;
               background:rgba(0,0,0,.55); color:#fff; border:1px solid #2a3242; font-weight:600; font-size:13px;
               text-shadow:none; margin-bottom:2px; }
  #stageback.show { display:block; }
  #chips { display:flex; gap:8px; overflow-x:auto; padding:8px 14px 0; background:#10141c;
           border-top:1px solid #1c2230; -webkit-overflow-scrolling:touch; scrollbar-width:none; }
  #chips::-webkit-scrollbar { display:none; }
  .chip { flex:none; background:#1c2230; color:#aeb8c2; border:1px solid #2a3242; border-radius:14px;
          padding:5px 12px; font-size:13px; font-weight:500; }
  .chip:active { background:#2a3242; }
  form { display:flex; gap:8px; padding:10px 14px; padding-bottom:max(10px, env(safe-area-inset-bottom));
         background:#10141c; }
  input[type=text] { flex:1; background:#0b0e14; border:1px solid #2a3242; color:#dce3ea;
         border-radius:18px; padding:9px 14px; font-size:16px; outline:none; }
  button { background:#1f6feb; color:#fff; border:0; border-radius:18px; padding:9px 16px;
         font-size:15px; font-weight:600; }
  button:disabled { opacity:.5; }
  /* 📞 the call button: idle → connecting (pulse) → live (green + pulsing dot). */
  #callBtn { background:#1c2230; border:1px solid #2a3242; color:#dce3ea; padding:9px 13px; }
  #callBtn.connecting { animation:vpulse 1s ease-in-out infinite; }
  #callBtn.live { background:#238636; border-color:#2ea043; }
  #callBtn.live .calldot { display:inline-block; width:8px; height:8px; border-radius:50%;
         background:#ff6b6b; margin-right:6px; animation:vpulse 1.2s ease-in-out infinite; }
  @keyframes vpulse { 0%,100% { opacity:1; } 50% { opacity:.45; } }
  #toast { position:fixed; left:50%; bottom:calc(88px + env(safe-area-inset-bottom));
           transform:translateX(-50%) translateY(8px); background:#3d1d20; color:#ffb3ad;
           border:1px solid #6e2c31; border-radius:10px; padding:8px 14px; font-size:13px;
           max-width:86%; opacity:0; pointer-events:none; transition:opacity .2s, transform .2s; z-index:60; }
  #toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  #toast.ok { background:#12261a; color:#7ee787; border-color:#1f6b3a; }
  /* Above everything incl. the stage (#stage is positioned and later in the
     DOM, so without a z-index the black video box painted OVER the gate on
     any viewport wide enough for the 16:9 stage to reach the centre). */
  #gate { position:fixed; inset:0; z-index:100; background:#0b0e14; display:flex; flex-direction:column;
          align-items:center; justify-content:center; gap:14px; padding:24px; text-align:center; }
  #gate.hidden { display:none; }
  #gate p { color:#8b98a5; max-width:320px; }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  #feed:focus-visible, #vchips:focus-visible, #crew:focus-visible, #filters:focus-visible, #chips:focus-visible { outline:2px solid #58a6ff; outline-offset:-2px; }
  /* Phone: #side is invisible to layout, its children stay body's flex items. */
  #side { display:contents; }
  /* Desktop (≥900px): the 16:9 stage used to be the whole viewport (1440×810 of
     900) and the feed got 20px. Two columns instead — the world on the left,
     letterboxed to whatever height is there; the conversation on the right as a
     phone-width column with its own scroll, composer pinned to its bottom. */
  @media (min-width: 900px) {
    body { display:grid; grid-template-columns:minmax(0,1fr) clamp(360px, 32vw, 460px);
           grid-template-rows:100dvh; }
    #stage { display:flex; flex-direction:column; min-height:0; padding-top:0; }
    #view { flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; }
    #video { flex:1; min-height:0; aspect-ratio:auto; object-fit:contain; }
    #hud { bottom:auto; top:0; padding:8px 12px 26px; align-items:flex-start;
           background:linear-gradient(rgba(0,0,0,.75), transparent); }
    #vitals { padding:9px 16px 10px; }
    #stage:not(.full) { cursor:zoom-in; }
    #side { display:flex; flex-direction:column; min-height:0; position:relative;
            background:#0b0e14; border-left:1px solid #1c2230; }
    #jump { position:absolute; bottom:120px; }
    #toast { bottom:88px; left:auto; right:16px; transform:translateY(8px); max-width:420px; }
    #toast.show { transform:translateY(0); }
    #feed { padding:12px 16px; }
  }
</style>
</head>
<body>
<div id="gate">
  <h1>⛏️ StrandsBot</h1>
  <p id="gateMsg">…</p>
  <button id="gateBtn" style="display:none"></button>
</div>
<div id="stage" role="region" aria-label="world view">
  <div id="view">
  <img id="video" alt="">
  <div id="vstall" role="status"><span><span class="spin"></span><span id="vtext"></span></span></div>
  <div id="hud">
    <span id="dot"></span>
    <div>
      <div id="hearts" class="bar"></div>
      <div id="food" class="bar"></div>
    </div>
    <div id="hudright">
      <div id="coords"></div>
      <div id="watchers"></div>
    </div>
    <button id="stageback" type="button" aria-label="Back to the bot's own camera">\u2190 bot</button>
    <button id="stopBtn" type="button" aria-label="Stop the bot: halt movement, digging and the journey" title="Stop — reflex, no model turn">STOP</button>
  </div>
  </div>
  <div id="vitals" aria-live="polite" aria-label="bot vitals">
    <div id="vstate">no telemetry yet</div>
    <div id="vchips" tabindex="0" aria-label="vitals"></div>
    <button id="invBtn" type="button" aria-expanded="false" aria-controls="inv">\uD83C\uDF92 bag</button>
    <div id="inv" aria-label="inventory" hidden></div>
  </div>
</div>
<main id="side">
<h1 class="sr">StrandsBot live</h1>
<div id="crew" tabindex="0" aria-label="journeys and workers"></div>
<div id="filters" role="group" tabindex="0" aria-label="feed filters"></div>
<div id="feed" role="log" aria-label="feed" tabindex="0"></div>
<button id="jump" type="button">new messages ↓</button>
<div id="chips" tabindex="0" aria-label="quick messages"></div>
<form id="composer">
  <button id="callBtn" type="button" data-state="idle" title="voice call" aria-label="voice call">📞</button>
  <input id="msg" type="text" placeholder="tell the bot…" aria-label="message to the bot" autocomplete="off">
  <button id="sendBtn">send</button>
</form>
</main>
<div id="toast" role="status"></div>
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
    const n = document.createElement('span'); n.className = 'ctitle'; n.textContent = t.title; n.title = t.title;
    top.appendChild(n);
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

function glyphBar(el, count, glyph) {
  const full = Math.max(0, Math.min(10, Math.round(count / 2)));
  el.innerHTML = '';
  for (let i = 0; i < 10; i++) {
    const s = document.createElement('span');
    s.className = i < full ? 'on' : 'off';
    s.textContent = glyph;
    el.appendChild(s);
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
  glyphBar(document.getElementById('hearts'), s.health ?? 0, '\\u2665');
  glyphBar(document.getElementById('food'), s.food ?? 0, '\\uD83C\\uDF57');
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
  invBtn.textContent = '\uD83C\uDF92 ' + (inv.stacks ? inv.stacks + ' stacks \u00b7 ' + inv.total : 'bag');
  if (!invOpen) return;
  invEl.innerHTML = '';
  if (!inv.rows.length) {
    const e = document.createElement('div'); e.className = 'slot empty'; e.textContent = lastTelemetry ? 'empty hands, empty bag' : 'no telemetry yet';
    invEl.appendChild(e); return;
  }
  for (const r of inv.rows) {
    const el = document.createElement('div'); el.className = 'slot' + (r.held ? ' held' : '');
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
