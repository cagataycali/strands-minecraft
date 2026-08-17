/* strands-minecraft landing — no framework, no CDN.
   Every number and tool name is read from numbers.json (written by scripts/site-numbers.mjs),
   so the page cannot drift from the tree. */
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sda = !reduced && CSS.supports?.('animation-timeline: view()');
  if (sda) document.documentElement.classList.add('sda');
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // nav hairline on scroll
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // copy buttons (clipboard API → execCommand fallback)
  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch {} ta.remove(); return ok;
  };
  $$('.copy').forEach((b) => b.addEventListener('click', async () => {
    if (await copyText(b.dataset.copy)) { b.classList.add('copied'); setTimeout(() => b.classList.remove('copied'), 1600); }
  }));

  // hero loop: 4 s cut from assets/demo-creeper.gif. Sources attach only when motion is allowed and the
  // connection is not save-data; the poster (hero.jpg, the same scene) stays for LCP and for reduced motion.
  const loop = $('.hero-loop');
  if (loop && !reduced && !navigator.connection?.saveData) {
    const add = (type, src) => { const s = document.createElement('source'); s.type = type; s.src = src; loop.appendChild(s); };
    add('video/webm', loop.dataset.webm); add('video/mp4', loop.dataset.mp4);
    loop.addEventListener('playing', () => loop.classList.add('playing'), { once: true });
    loop.load(); loop.play().catch(() => {});
  }

  // reveal fallback: IntersectionObserver sets .in (CSS view() timelines take over where supported)
  let io = null;
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }),
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    $$('.reveal').forEach((el) => io.observe(el));
  } else document.documentElement.classList.add('no-io');

  // GIFs: poster first, swap to the real capture when near the viewport (saves ~1.2 MB above the fold)
  const gifs = $$('img[data-gif]');
  const swap = (img) => { if (img.dataset.gif) { img.src = img.dataset.gif; delete img.dataset.gif; } };
  if ('IntersectionObserver' in window) {
    const gio = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { swap(e.target); gio.unobserve(e.target); } }), { rootMargin: '300px' });
    gifs.forEach((g) => gio.observe(g));
  } else gifs.forEach(swap);

  // numbers.json → every data-num, the tool chips, the route table
  const DOMAINS = [
    ['perception', 'Perception'], ['movement', 'Movement'], ['world', 'World'], ['inventory', 'Inventory'],
    ['combat', 'Combat'], ['interaction', 'Interaction'], ['chat', 'Chat'], ['vision', 'Vision'], ['memory', 'Memory'],
    ['journeys', 'Journeys'], ['fleet', 'Fleet'], ['voice', 'Voice'],
  ];
  const fmt = (v, f) => (f === 'k' ? (v / 1000).toFixed(1).replace(/\.0$/, '') : String(v));
  const countUp = (el, v, f) => {
    if (reduced || v < 10) { el.textContent = fmt(v, f); return; }
    const t0 = performance.now(), dur = 900;
    const step = (t) => { const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(Math.round(v * e), f); if (p < 1) requestAnimationFrame(step); else el.textContent = fmt(v, f); };
    requestAnimationFrame(step);
  };
  fetch('numbers.json').then((r) => r.json()).then((n) => {
    $$('[data-num]').forEach((el) => { const v = n[el.dataset.num]; if (v == null) return;
      if (el.closest('#numbers') && 'IntersectionObserver' in window) {
        const o = new IntersectionObserver((es) => { if (es[0].isIntersecting) { countUp(el, v, el.dataset.fmt); o.disconnect(); } });
        o.observe(el);
      } else el.textContent = fmt(v, el.dataset.fmt); });
    const groups = new Map(DOMAINS.map(([k]) => [k, []]));
    for (const name of n.toolNames) { const d = n.toolDomains[name] ?? 'other'; if (!groups.has(d)) groups.set(d, []); groups.get(d).push(name); }
    const label = Object.fromEntries(DOMAINS);
    const host = $('#tool-groups'); host.textContent = '';
    const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    for (const [k, names] of groups) {
      if (!names.length) continue;
      const sec = document.createElement('section'); sec.className = 'tg reveal';
      sec.innerHTML = `<h3>${label[k] ?? k}<span>${names.length}</span></h3><ul>${names.map((t) =>
        `<li><button type="button" data-tool="${t}" aria-pressed="false">${t}</button></li>`).join('')}</ul>`;
      host.appendChild(sec);
      if (io) io.observe(sec); else sec.classList.add('in');
    }
    // one description line for the whole grid: hover / focus / tap a chip → its real description: (+ file:line)
    const desc = $('#tool-desc'), sheet = $('#tool-sheet'); const hint = desc?.innerHTML; let pinned = null;
    const show = (t) => {
      if (!desc) return;
      const d = n.toolDescriptions?.[t]; if (!d) return;
      const src = n.toolSources?.[t];
      const html = `<b>${esc(t)}</b> — ${esc(d)}` + (src ? `<span class="td-src"><code>${esc(src)}</code></span>` : '');
      desc.innerHTML = html; if (sheet) { sheet.innerHTML = html; sheet.classList.add('showing'); }
    };
    const clear = () => { if (pinned) show(pinned); else if (desc) { desc.innerHTML = hint; sheet?.classList.remove('showing'); } };
    host.addEventListener('pointerover', (e) => { const b = e.target.closest('button[data-tool]'); if (b) show(b.dataset.tool); });
    host.addEventListener('pointerleave', clear);
    host.addEventListener('focusin', (e) => { const b = e.target.closest('button[data-tool]'); if (b) show(b.dataset.tool); });
    host.addEventListener('focusout', clear);
    host.addEventListener('click', (e) => { const b = e.target.closest('button[data-tool]'); if (!b) return;
      const t = b.dataset.tool; pinned = pinned === t ? null : t;
      $$('button[data-tool]', host).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.tool === pinned)));
      pinned ? show(pinned) : clear(); });
    // read deeper: hook = the file's first sentence, minutes counted by the script (200 wpm) — static fallbacks stand without JSON
    if (Array.isArray(n.docs)) {
      const byPath = Object.fromEntries(n.docs.map((d) => [d.path, d]));
      $$('#docs a').forEach((a) => {
        const path = a.dataset.doc; const m = a.querySelector('.doc-m');
        const d = byPath[path];
        if (d) { a.querySelector('.doc-h').textContent = d.hook; m.innerHTML = `<b>${esc(d.minutes)} min</b> · ${esc(path)}`; }
        else if (path === 'docs/findings/' && n.findings) { a.querySelector('.doc-h').textContent = `${n.findings.count} write-ups, e.g. “${n.findings.titles[n.findings.titles.length - 1]}”`; m.innerHTML = `<b>${esc(n.findings.minutes)} min</b> · ${n.findings.count} files`; }
      });
    }
    const tb = $('#routes tbody');
    if (Array.isArray(n.routes) && n.routes.length) {
      tb.innerHTML = n.routes.map((r) => `<tr><td><code>${r.route}</code></td><td class="${r.gate}">${r.gate}</td></tr>`).join('');
    }
  }).catch(() => { /* static fallbacks in the HTML stand */ });

  // terminal: types REAL log lines in the repo's grammar (src/index.ts:52,62,115,125,138,422,730,768; src/model.ts:96)
  const LINES = [
    ['⛏️  strands-minecraft — connecting…', 'dim'],
    ['🧠 model bedrock · global.anthropic.claude-sonnet-5 · us-west-2', 'dim'],
    ['✅ Spawned as StrandsBot at (12.5, 64, -87.5)'],
    ['💬 Type to the bot · "v" push-to-talk · "call" realtime voice (barge-in!) · "exit" quits.', 'dim'],
    ['you> keep mining until you have 64 iron', 'you'],
    ['🤖 On it — starting a journey for 64 iron ingots.'],
    ['🧭 [jm1x9k2a #1] Found an exposed iron vein 14 blocks north and dug it out. [Δ +6 raw_iron, moved 21m]'],
    ['🧭 [jm1x9k2a #2] Six raw iron smelting in the furnace by the stairs; mining the next vein while it cooks. [Δ +9 raw_iron, -1 hp, moved 33m]'],
    ['you> hire someone to chop wood by the water', 'you'],
    ['👥 [Chopper #1] joined the server, starting: "fell the oaks by the water, 32 logs"'],
    ['⚡ reflex: eat'],
    ['👥 [Chopper #2] Felled two oaks at the shore; 11 oak logs in the bag, replanting saplings.'],
    ['💭 Dusk. The player is 40 m off and safe; I\'ll stay in the mine and keep the torches going.'],
    ['🧭 [jm1x9k2a #7] Collected the ingots and stored them in the chest at the stairs. [Δ +12 iron_ingot, moved 8m]'],
    ['🧭 [jm1x9k2a #7] journey done: 64 iron ingots in the chest by the stairs.'],
  ];
  const out = $('#t-out'); const term = $('#terminal');
  if (out) {
    if (reduced) {
      out.innerHTML = LINES.map(([l, c]) => `<span class="${c ? 't-' + c : ''}">${esc(l)}</span>`).join('\n');
    } else {
      let li = 0, ci = 0, timer = null, started = false, visible = false;
      const tick = () => {
        if (!visible) { timer = null; return; }
        if (li >= LINES.length) { timer = null; return; }
        const [line, cls] = LINES[li];
        const human = cls === 'you';
        if (ci === 0) { if (li > 0) out.appendChild(document.createTextNode('\n')); const s = document.createElement('span'); if (cls) s.className = 't-' + cls; out.appendChild(s); }
        const span = out.lastElementChild; ci++;
        span.textContent = line.slice(0, ci);
        // a human types the you> lines (30–45 ms/char); the program prints the rest
        let delay = human ? 30 + Math.random() * 15 : 9 + Math.random() * 6;
        if (ci >= line.length) { li++; ci = 0; delay = human ? 700 : line.startsWith('🧭') || line.startsWith('👥') ? 650 : 380; }
        timer = setTimeout(tick, delay);
      };
      const tio = new IntersectionObserver((es) => es.forEach((e) => {
        visible = e.isIntersecting;
        if (visible && !timer) { started = true; timer = setTimeout(tick, 300); }
      }), { threshold: 0.3 });
      tio.observe(term);
    }
  }
  function esc(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
})();
