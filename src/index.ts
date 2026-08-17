import 'dotenv/config';
import readline from 'node:readline';
import { createLiveBody } from './body.js';
import { botCreateOptions } from './bot.js';
import { createMinecraftAgent } from './agent.js';
import { createModel, describeModel, resolveModelSpec } from './model.js';
import { Session } from './session.js';
import { JourneyRunner, journeyTools } from './journeys.js';
import { Fleet, fleetTools, crewSnapshot } from './fleet.js';
import { writePlace, recordDeath, deathContext, noteDamageSource } from './tools/memory.js';
import { Thinker } from './thinker.js';
import { startSentinel } from './sentinel.js';
import { startReflexes } from './reflexes.js';
import { legs, registerLegs } from './legs.js';
import { worldDigest, inventoryHighlights } from './digest.js';
import { startWeb, stopBody, type WebRail } from './web.js';
import type { TelemetryExtras } from './web/tiny.js';
import { startRecording, stopRecording, isRecording, speak } from './voice.js';
import { RealtimeCall } from './realtime/realtime.js';
import { createVoiceCall } from './voicecall.js';
import { VoiceBridge, voiceBridgeTools } from './voicebridge.js';
import { NoteQueue } from './notes.js';
import { classifyMessage, buildChatPrompt, systemNoteFor } from './chatrail.js';
import { allTools } from './tools/index.js';
import { checkMemory, memoryProbe, census, heapLimitMb } from './memcheck.js';
import { cfg } from './config.js';
import { carriedView, countCarried, readArmed } from './tools/helpers.js';
import { startLoopWatch } from './loopwatch.js';
import { cameraWarmup } from './tools/vision.js';

const VOICE_REPLIES = process.env.VOICE_REPLIES === 'true';

/** Crew bot usernames whose chat we log but never fork a turn on — this is the
 *  guard against the bot↔bot chat cascade when several agents share a server.
 *  Set PEER_BOTS="Ivy,Kai,Nova,StrandsBot" (our own name is harmless, self is
 *  filtered first). Empty = classic single-bot behaviour. */
const PEER_BOTS = (process.env.PEER_BOTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Total registered listeners on an emitter — a listener leak shows up here
 *  before it shows up as bytes, and every listener closure retains its captures. */
interface EmitterLike { eventNames?: () => Array<string | symbol>; listenerCount?: (n: string | symbol) => number }
const listenerTotal = (e?: EmitterLike): number => {
  if (!e?.eventNames || !e.listenerCount) return 0;
  let n = 0;
  for (const name of e.eventNames()) n += e.listenerCount(name);
  return n;
};

const main = async () => {
  console.log('⛏️  strands-minecraft — connecting…');
  // Say out loud whether the memory ceiling is real (issue #13): a mem_limit
  // larger than the Docker VM means the OOM killer, not the heap cap, decides
  // how this process dies — and that lesson otherwise costs a blind crash.
  const mem = checkMemory();
  if (mem.level !== 'ok') console.log(`${mem.level === 'warn' ? '🚨' : '⚠️ '} ${mem.text}`);
  // A body that survives chat_validation_failed kicks (mineflayer#3838):
  // `bot` is a proxy over the current connection; tools built once keep working.
  const body = await createLiveBody();
  const bot = body.bot;
  console.log(`✅ Spawned as ${bot.username} at ${bot.entity.position}`);

  // Journey runner is late-bound: its tools mount on the agent, the agent goes
  // into the Session, then bind() closes the cycle. The fleet has no such
  // cycle — workers are independent bodies with their own agents.
  const journeys = new JourneyRunner();
  const fleet = new Fleet();
  // The voice bridge: every rail's "a human should HEAR this" queue. A live
  // voice call drains it; the model decides what deserves speech. voice_say
  // below gives the model itself a deliberate push into it.
  const voiceBridge = new VoiceBridge();
  // The bridge sweeps its own queue: the drain only runs inside a live call,
  // so a bot nobody calls would otherwise hoard five-minute-old sentences
  // forever. Unref'd timer — it never keeps the process alive.
  voiceBridge.startAutoFlush();
  // Collision guard: the tab list knows everyone online (players AND bots) —
  // hiring a worker under a name that's already walking around would kick or
  // refuse the real holder of that login.
  fleet.isNameTaken = (name) =>
    Object.keys(bot.players ?? {}).some((p) => p.toLowerCase() === name.toLowerCase());
  // STRANDS_MODEL_PROVIDER decides the brain once, here — the primary and every
  // worker it hires share this one instance (one provider, one quota). A
  // missing optional provider package fails now, with the npm install line,
  // not on the first turn.
  const modelSpec = resolveModelSpec();
  const model = await createModel(modelSpec);
  console.log(describeModel(modelSpec));
  fleet.model = model;
  const { agent, forkFactory } = createMinecraftAgent(bot, {
    model,
    extraTools: [...journeyTools(journeys), ...fleetTools(fleet), ...voiceBridgeTools(voiceBridge)],
    // A kick must end the tool calls that were riding the dead socket (issue
    // #20) — otherwise the turn, and the human message that started it, hang.
    epoch: body.epoch,
  });
  const session = new Session(agent, forkFactory);
  // A provider failure names its class and dumps the transcript SHAPE (roles +
  // tool-pair ids, no content) — so an intermittent 4xx is judged, not guessed
  // (issue #14). Goes to the console and the dashboard feed.
  session.onDiagnosis = (report) => {
    console.warn(report);
    for (const line of report.split('\n')) web?.log('system', 'session', line);
  };
  journeys.bind(session);
  const thinker = new Thinker(session, journeys, fleet);

  // Web rail is late-bound like the journey runner: the feed callbacks below
  // capture it, but it needs run() — assigned right after run is defined.
  let web: WebRail | null = null;

  // Briefings are visible even before a call exists — the dashboard feed and
  // console see every accepted push (dedupes stay silent by design).
  voiceBridge.onPush = (b) => {
    console.log(`🔈 briefing[${b.importance}] ${b.source}: ${b.text.slice(0, 120)}`);
    web?.log('voice', b.source, `briefing[${b.importance}] ${b.text.slice(0, 200)}`);
  };

  const sayInChat = (text: string) => {
    for (const chunk of text.match(/.{1,250}/gs) ?? []) bot.chat(chunk);
  };

  journeys.onProgress = (j, step) => {
    console.log(`🧭 [${j.id} #${j.iterations}] ${step}`);
    web?.log('journey', `${j.id} #${j.iterations}`, step);
    if (j.status !== 'running') {
      sayInChat(`journey ${j.status}: ${(j.result ?? '').slice(0, 200)}`);
      // Terminal outcomes are voice-worthy news — a player away from the
      // keyboard hears "the tower is done" instead of discovering it later.
      voiceBridge.push('journey', `Journey "${j.goal}" ${j.status}: ${(j.result ?? '').slice(0, 300)}`, 1);
    }
  };
  fleet.onProgress = (w, line) => {
    console.log(`👥 [${w.name} #${w.steps}] ${line}`);
    web?.log('worker', `${w.name} #${w.steps}`, line);
    if (w.status === 'working' || w.status === 'connecting') return;
    // Terminal state: the BOSS must hear it, not just the console — otherwise
    // the primary agent never learns its hire finished and can't relay the
    // result, collect the goods, or replace a failed worker. Rides the same
    // note rail as deaths/reconnects; the thinker delivers it when idle.
    if (w.status !== 'dismissed') {
      queueNote(`(system) Your worker ${w.name} is ${w.status} after ${w.steps} step(s). Task: "${w.task}". Outcome: ${(w.result ?? '').slice(0, 300)}${w.status === 'failed' ? ' — decide: re-hire with a sharper brief, or tell the player it needs them.' : ' — its drops/chest work stays where it left it; follow up if the task feeds yours.'}`);
      voiceBridge.push('fleet', `Worker ${w.name} ${w.status} after ${w.steps} step(s) on "${w.task}": ${(w.result ?? '').slice(0, 300)}`, 1);
    }
    sayInChat(`${w.name} ${w.status}: ${(w.result ?? '').slice(0, 200)}`);
  };
  thinker.onThought = (t) => { console.log(`💭 ${t}`); web?.log('thought', 'thinker', t); };
  thinker.hasNotes = () => pendingNotes.hasPending();
  thinker.takeNotes = () => takeNotesAudited();

  // Every rail goes through session.ask(): concurrent requests fork the
  // history and fold back — nobody is told to wait.
  // System notes ride in FRONT of the next request, never into a possibly
  // mid-turn history (that can split a toolUse from its result). A queue,
  // not a string: a death note must not overwrite a reconnect note that
  // hasn't been delivered yet, nor either of them a worker report.
  // A NoteQueue, not an array: capped, aged, and collapsed by subject, because
  // one circling phantom queued 94 sightings in front of a human ask (issue #32).
  // Windows and cap live in cfg.notes (NOTES_CAP / NOTES_FRESH_MS /
  // NOTES_USABLE_MS) — a note past the fresh window is stamped with its age,
  // and a perishable one past the usable window never reaches the mind (#43's
  // class on this rail: a 26-minute-old note was being delivered as news).
  const pendingNotes = new NoteQueue();
  const queueNote = (n: string) => { pendingNotes.push(n); };
  /**
   * Every drain of the note rail, with the rot named. A queue that quietly
   * thins is indistinguishable from a quiet world — the voice rail learned this
   * as #43, so the mind rail says it out loud too: which sinks wrote notes that
   * were never worth delivering by the time a turn came around.
   */
  const takeNotesAudited = (): string => {
    const { text, delivered, stamped, perished, sources } = pendingNotes.takeAudited();
    if (delivered > 0) {
      console.log(`🗒 ${delivered} note(s) handed to the mind${stamped > 0 ? `, ${stamped} stamped with its age (past the ${Math.round(cfg.notes.freshMs / 1_000)}s fresh window)` : ''}`);
    }
    if (perished > 0) {
      const by = Object.entries(sources).map(([s, n]) => `${s}: ${n}`).join(', ');
      console.log(`🗒 ${perished} note(s) perished unread (older than the ${Math.round(cfg.notes.usableMs / 1_000)}s usable window) — ${by}`);
      web?.log('system', 'notes', `${perished} note(s) perished unread — ${by}`);
    }
    return text;
  };
  // Why a turn is taking so long — the receipt's "still running after 398s" is
  // true but useless on its own (issue #33). These are the things that actually
  // stretch one ask into ten minutes: reflex interrupts, a death, a reconnect.
  const turnEvents: Array<{ at: number; what: string }> = [];
  const recordTurnEvent = (what: string) => {
    turnEvents.push({ at: Date.now(), what });
    if (turnEvents.length > 60) turnEvents.shift();
  };
  const whySlow = (sinceMs: number): string | undefined => {
    const cutoff = Date.now() - sinceMs;
    const since = turnEvents.filter((e) => e.at >= cutoff);
    if (since.length === 0) return undefined; // nothing to blame: say nothing
    const reflexes = since.filter((e) => e.what.startsWith('reflex:'));
    const parts: string[] = [];
    if (reflexes.length) {
      const names = [...new Set(reflexes.map((e) => e.what.slice(7)))].join(', ');
      parts.push(`${reflexes.length} reflex interrupt(s) (${names})`);
    }
    for (const kind of ['died', 'reconnected']) {
      const n = since.filter((e) => e.what === kind).length;
      if (n) parts.push(`${n}x ${kind}`);
    }
    return `${parts.join(' + ')} since it was sent`;
  };
  // Errands the previous process died holding: tell the agent once, up front.
  // It decides whether the goal still makes sense — never auto-resume a
  // journey into a world/inventory that may have moved on since.
  for (const j of journeys.interrupted) {
    // Age is decision-relevant: a 30-minute-old errand may be moot even when it
    // is fresh enough to mention, so say how old it is and let the mind judge.
    const ageMin = Math.round((Date.now() - j.startedAt) / 60_000);
    queueNote(`(system) A previous session was INTERRUPTED mid-journey ${j.id} ${ageMin} min ago: "${j.goal}" (${j.iterations} step(s) done; last: ${j.journal[j.journal.length - 1] ?? 'none'}). Check journey_status ${j.id}, then start_journey with the same goal if it still makes sense — progress like gathered materials is already in the world/inventory. If it has been overtaken by events, say so and drop it.`);
  }
  for (const w of fleet.interrupted) {
    queueNote(`(system) Worker ${w.name} was INTERRUPTED when a previous session died (task: "${w.task}", ${w.steps} step(s) done; last: ${w.journal[w.journal.length - 1] ?? 'none'}). Its body left the server; its drops/chest work remain in the world. Re-hire (manage_bots) with the same name and a brief that includes the journal head start — if the task still matters.`);
  }
  const run = async (text: string, opts: { chat?: boolean; voice?: boolean; replyTo?: string } = {}) => {
    thinker.touch();
    if (session.busy > 0) console.log(`⑂ forking (${session.busy} turn(s) in flight)`);
    const note = takeNotesAudited(); // stale sightings die at the door
    web?.log('in', opts.chat ? 'player' : 'you', text, opts.replyTo); // its own say id, so the answer can name it
    try {
      const answer = await session.ask(note ? `${note}\n\n${text}` : text);
      console.log(`🤖 ${answer}`);
      // Tagged with the ask it answers (issue #25) — an untagged 'out' is
      // self-driven narration and must never read as a reply to a human.
      web?.log('out', bot.username ?? 'bot', answer, opts.replyTo);
      if (opts.chat && answer) sayInChat(answer);
      if ((opts.voice || VOICE_REPLIES) && answer) await speak(answer);
      return { answer };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ ${msg}`);
      web?.log('system', 'error', msg);
      if (opts.chat) bot.chat(`ouch: ${msg.slice(0, 200)}`);
      // Swallowing the throw keeps one bad turn from killing the process, but
      // the CALLER still has to learn the truth: the web rail turns this into a
      // FAILED say-receipt instead of a green 'answered' one (issue #39).
      return { error: err };
    }
  };

  // A stalled event loop is a connection hazard, not a performance nit: the
  // keep-alive we owe the server is answered here, so anything that hogs the
  // process can get the bot kicked (issue #18 — the camera warm-up did exactly
  // that). Watch it, and name the consequence when it happens.
  const loopWatch = startLoopWatch({
    culprit: () => {
      const w = cameraWarmup();
      return w && `the camera warms up (headless Chrome + viewer page, ${Math.round(w.sinceMs / 1_000)}s in)`;
    },
    emit: (v) => {
      const line = `🩺 ${v.text}`;
      if (v.level === 'risk') console.error(line); else console.log(line);
      web?.log('system', 'health', v.text);
    },
  });

  // Rail 6: the web dashboard — video + feed + messages from the phone, plus
  // the /voice WebSocket: the phone's mic and speaker become the bot's ears
  // and mouth (createVoiceCall — the same call the CLI dials, browser audio).
  web = startWeb(bot, (text, ctx) => run(`(from CagatayCali via the web dashboard) ${text}`, { replyTo: ctx.sayId }), () => ({
    journey: (() => {
      // The running journey, or the most recent one so 'what happened?' has
      // an answer on the dashboard too (interrupted ones surface here).
      const j = journeys.running ?? journeys.list().sort((a, b) => b.startedAt - a.startedAt)[0];
      return j && { id: j.id, goal: j.goal, status: j.status, step: j.iterations, last: j.journal[j.journal.length - 1] };
    })(),
    // crewSnapshot, not a hand-rolled filter: it drops 14-hour-old
    // 'interrupted' ghosts and carries each card's reason + age (live soak).
    workers: crewSnapshot(fleet.list()),
    notes: pendingNotes.stats(),
  }), process.env.OPENAI_API_KEY && process.env.VOICE_DISABLED !== 'true' ? {
    createCall: (transport, onEvent) => createVoiceCall({
      apiKey: process.env.OPENAI_API_KEY!,
      bot,
      agent,
      tools: [...allTools(bot), ...journeyTools(journeys)],
      touch: () => thinker.touch(),
      transport,
      onEvent: (e) => {
        // Mirror the spoken exchange into the dashboard feed + console, then
        // hand the event to the WS layer for the phone's call surface.
        if (e.type === 'turn' && !e.continuation) {
          console.log(`📞 🗣 ${e.user} → ${e.assistant.slice(0, 200)}`);
          web?.log('voice', 'call', `🗣 ${e.user} — ${e.assistant}`);
        } else if (e.type === 'tool_call') web?.log('voice', 'call', `⚙ ${e.name}`);
        else if (e.type === 'status') { console.log(`📞 web call: ${e.status}`); web?.log('voice', 'call', `📞 ${e.status}`); }
        else if (e.type === 'error') { console.error(`📞 web call: ${e.error}`); web?.log('voice', 'call', `error: ${e.error}`); }
        onEvent(e as { type: string } & Record<string, unknown>);
      },
    }),
    briefings: voiceBridge,
  } : undefined, {
    // The say-receipt's evidence: is anything actually running, and what has
    // been interrupting it (issue #33 — it once cried "drop, re-send" at 398s
    // on a turn that answered correctly at 619s).
    busy: () => session.busy,
    why: whySlow,
  }, {
    // 🔥 The tiny endpoint (src/web/tiny.ts): what the phone and the relay
    // read next to the passkey dashboard. Closures, so web.ts stays free of
    // agent imports.
    mc: () => {
      const o = botCreateOptions();
      return { host: o.host, port: o.port, version: (bot as { version?: string }).version ?? o.version ?? null, connected: !!bot.entity && !!bot.player, epoch: body.epoch() };
    },
    telemetry: () => {
      const j = journeys.running;
      const workers = crewSnapshot(fleet.list());
      const task: TelemetryExtras['task'] = j
        ? { kind: 'journey', text: `${j.goal}${j.journal.length ? ` — ${j.journal[j.journal.length - 1]}` : ''}`.slice(0, 300), since_s: Math.round((Date.now() - j.startedAt) / 1_000) }
        : session.busy > 0
          ? { kind: 'turn', text: `${session.busy} turn(s) in flight`, since_s: 0 }
          : workers.some((w) => w.status === 'working')
            ? { kind: 'fleet', text: workers.filter((w) => w.status === 'working').map((w) => `${w.name}: ${w.task}`).join('; ').slice(0, 300), since_s: 0 }
            : { kind: 'idle', text: '', since_s: 0 };
      return {
        task,
        thinker: { enabled: thinker.enabled, next_in_s: thinker.nextInS() },
        crew: workers.map((w) => ({ name: w.name, job: w.task, alive: w.status === 'working' || w.status === 'connecting' })),
        connection: { connected: !!bot.entity && !!bot.player, epoch: body.epoch(), reconnects: reconnects },
        mem: { heapMb: Math.round(process.memoryUsage().heapUsed / 1048576), limitMb: heapLimitMb() },
      };
    },
    stop: () => {
      const stopped = stopBody(bot);
      const j = journeys.running;
      if (j && journeys.stop(j.id)) stopped.push(`journey ${j.id}`);
      web?.log('system', 'tiny', `STOP — halted ${stopped.join(', ') || 'nothing (idle)'}`);
      return stopped;
    },
  });

  // Rail 1: in-game chat — wired per-connection so it survives reconnects.
  // NOT bot.on('chat'): that event is a regex over every message mineflayer
  // sees, so server command feedback ("[Cagatay: Teleported ...]") arrives
  // wearing a player's name and buys a whole forked turn. 'messagestr' keeps
  // the packet's position and sender uuid, which is the actual truth — see
  // src/chatrail.ts.
  body.onEachBot((b) => {
    // mineflayer's typings stop at 3 params; the runtime emits
    // (text, position, jsonMsg, senderUuid, verified) — the last two are the
    // whole point here, so the handler is typed by hand and cast on the way in.
    const onMessage = (raw: string, position: string, _json: unknown, senderUuid?: string) => {
      const verdict = classifyMessage({
        position,
        raw,
        senderUuid: senderUuid as string | undefined,
        resolveName: (uuid) => Object.values(b.players).find((p) => p?.uuid === uuid)?.username,
        selfUsername: b.username,
        selfUuid: b.player?.uuid,
        peerBots: PEER_BOTS,
      });
      if (verdict.kind === 'self') return;
      if (verdict.kind === 'peer') {
        // A crew bot said something. Log it so it's visible, but NEVER buy a
        // turn on it — bot↔bot chat is what cascades into a runaway loop and
        // burns the shared model quota. Humans still get a turn (below).
        console.log(`🤖 <${verdict.username}> ${verdict.text}`);
        web?.log('chat', verdict.username, verdict.text);
        return;
      }
      if (verdict.kind === 'system') {
        console.log(`📃 ${verdict.text}`);
        web?.log('system', 'server', verdict.text);
        // Free rail only: a note rides in front of the next real turn, so a
        // teleport receipt informs the bot without costing a model call.
        const note = systemNoteFor(verdict.text, b.username);
        if (note) queueNote(note);
        return;
      }
      console.log(`💬 <${verdict.username}> ${verdict.text}`);
      web?.log('chat', verdict.username, verdict.text);
      void run(buildChatPrompt(verdict.username, verdict.text, verdict.verified), { chat: true });
    };
    b.on('messagestr', onMessage as Parameters<typeof b.on<'messagestr'>>[1]);
    b.on('kicked', (reason) => console.error('⛔ kicked:', reason));
    b.on('error', (err) => console.error('⛔ error:', err.message));
  });
  let reconnects = 0; // for /api/telemetry connection.reconnects
  body.onRevive = (b, cause) => {
    reconnects++;
    console.log(`🔁 back in the world as ${b.username} at ${b.entity?.position}`);
    // The agent should hear about the blink — but NEVER by pushing into a
    // possibly-mid-turn history (that can split a toolUse from its result).
    // It rides in front of the next request instead.
    recordTurnEvent('reconnected');
    queueNote(`(system) Your connection dropped ("${cause}" — the known signed-chat kick, mineflayer#3838, not your fault) and you reconnected. Pathfinding goals were lost; re-issue movement if you were mid-errand.`);
  };
  // Corpse guard (issue #6.1): after the body exhausts its reconnect attempts
  // it stops trying — and without this handler the process kept "living"
  // against a dead proxy: reflex tick firing, sentinel polling, thinker
  // spending model tokens, journeys burning steps whose every tool call
  // rejects, dashboard still green. Shut every rail down and exit non-zero so
  // a supervisor (compose `restart: unless-stopped`) brings a FRESH process;
  // a bare `npm start` user gets the loud log and the real cause. The rails
  // referenced here are consts declared below — the handler only ever fires
  // minutes after startup finished wiring them.
  body.onGaveUp = (cause) => {
    console.error(`💀 body gave up reconnecting (${cause}). Stopping every rail and exiting 1 — restart me (or let docker) when the server is back.`);
    web?.log('system', 'body', `gave up reconnecting (${cause}) — shutting down`);
    try { thinker.stop(); sentinel?.stop(); reflexes?.stop(); call?.stop(); fleet.retireAll(); voiceBridge.shutdown(); } catch { /* dying anyway */ }
    // One beat for the SSE feed to flush the farewell, then go.
    setTimeout(() => { try { web?.close(); } catch { /* closing */ } process.exit(1); }, 1500).unref();
  };

  // Rail 5: reflexes — pain wakes the agent. Keyed on entityHurt for OUR
  // entity, not the 'health' event (which also fires for food ticks and
  // regen — a bot that panics while healing is a bot nobody wants).
  // Debounced two ways: one reflex turn in flight at a time, plus a cooldown
  // so a zombie landing three hits doesn't buy three forks. The reflex goes
  // through run() → session.ask(), so it forks past any turn in flight and
  // journeys yield to it like any live turn — pain preempts errands.
  const REFLEX_COOLDOWN_MS = Number(process.env.REFLEX_COOLDOWN_MS ?? 15_000);
  const HUNGER_NOTE_AT = Number(process.env.HUNGER_NOTE_AT ?? 6);
  let lastReflex = 0;
  let reflexInFlight = false;
  // One gate for EVERY urgent-turn source (pain, primed creepers, drowning):
  // one reflex turn in flight at a time plus a cooldown, so a burst of danger
  // buys one focused turn, not a fork storm.
  const reflexRun = (name: string, prompt: string) => {
    if (process.env.REFLEX_DISABLED === 'true') return;
    const now = Date.now();
    if (reflexInFlight || now - lastReflex < REFLEX_COOLDOWN_MS) return;
    lastReflex = now;
    reflexInFlight = true;
    recordTurnEvent(`reflex:${name}`);
    console.log(`⚡ reflex: ${name}`);
    web?.log('system', 'reflex', `${name}: ${prompt.slice(0, 160)}`);
    void run(prompt).finally(() => { reflexInFlight = false; });
  };
  // Hunger is armed/disarmed with hysteresis, and the flag lives OUTSIDE
  // onEachBot on purpose: a reconnect re-fires 'health' with the same low
  // food, and a bot that re-announces its hunger after every signed-chat
  // kick is a bot nobody wants.
  let hungerArmed = true;
  body.onEachBot((b) => {
    b.on('entityHurt', (entity, source) => {
      // `entity` can be undefined: mineflayer looks the id up in bot.entities
      // and emits whatever it finds. Guard before the identity test — the same
      // missing check killed a soak from the worker rail.
      if (!entity || !b.entity || entity.id !== b.entity.id) return;
      // Snapshot the scene NOW — by the time the model answers, the zombie
      // has moved and the culprit may have despawned.
      const me = b.entity.position;
      // 1.20+ damage_event names the attacker directly; may be undefined
      // (fall, fire, cactus) or missing entirely on older servers.
      const attacker = source
        ? (source.type === 'player' ? (source.username ?? 'a player') : (source.name ?? 'something'))
        : undefined;
      const threats = Object.values(b.entities)
        .filter((e) => e.id !== b.entity.id && e.position && me.distanceTo(e.position) < 16
          && (e.type === 'hostile' || (e.kind ?? '').toLowerCase().includes('hostile') || e.type === 'player'))
        .sort((a, z) => me.distanceTo(a.position) - me.distanceTo(z.position))
        .slice(0, 5)
        .map((e) => `${e.name === 'player' ? (e.username ?? 'player') : (e.name ?? '?')} ${me.distanceTo(e.position).toFixed(1)}m away`);
      // #35: mineflayer's 'death' event carries no cause, so the LAST thing that
      // hit us is the only evidence a death site has about what kills there.
      if (attacker) noteDamageSource(attacker);
      console.log(`⚡ hurt${attacker ? ` by ${attacker}` : ''} — health ${(b.health ?? 0).toFixed(0)}/20${threats.length ? `, nearby: ${threats.join(', ')}` : ''}`);
      reflexRun(
        'hurt',
        `(reflex) You just TOOK DAMAGE${attacker ? ` from ${attacker.toUpperCase()}` : ''} — health ${(b.health ?? 0).toFixed(0)}/20, food ${b.food ?? '?'}/20. ` +
        (attacker
          ? `The attacker is identified: ${attacker}. `
          : threats.length
            ? `Likely culprits nearby: ${threats.join('; ')}. `
            : 'Nothing hostile in sight — could be fall, fire, lava, drowning or cactus. ') +
        'Handle the danger NOW, before anything else: fight back (attack_entity until=\'dead\' arms your strongest weapon itself and fights the whole duel), or retreat/pillar up if outmatched or low, deal with the environment (get out of lava/water, extinguish), and eat if safe. ' +
        'If a player is attacking you, one chat line to them is allowed.'
      );
    });
    // Starvation is SILENT: food drains with no dedicated event, sprint dies
    // below 7 drumsticks, and the first thing entityHurt hears about it is
    // starvation DAMAGE at food 0 — the pain reflex firing at the moment
    // eating can no longer prevent it. Catch the slide at the threshold
    // (HUNGER_NOTE_AT, default 6) instead. A note, not a reflex fork: hunger is urgent-soon, not
    // urgent-now — the note rail delivers immediately when idle (iter11's
    // thinker trigger) and rides in front of the very next turn when busy.
    // Once per hunger episode: re-arms only after food recovers to 14+, so a
    // meal of one berry doesn't buy a second warning two ticks later.
    b.on('health', () => {
      if (process.env.REFLEX_DISABLED === 'true') return;
      const food = b.food;
      if (typeof food !== 'number') return; // pre-spawn tick
      if (hungerArmed && food <= HUNGER_NOTE_AT) {
        hungerArmed = false;
        console.log(`🍗 hungry — food ${food}/20`);
        queueNote(
          `(system) You are HUNGRY — food ${food}/20. Below 7 you cannot sprint; at 0 you take starvation damage. ` +
          `Eat NOW — call eat with no item and it picks the best fit itself. Nothing safe in the bag? It will say what risky food you carry; otherwise get food the fastest way in reach: ` +
          `kill an animal and eat the drop, harvest a crop, or fish — and consider stocking a few meals while you're at it.`
        );
      } else if (!hungerArmed && food >= 14) {
        hungerArmed = true; // properly fed again — the next slide is news
      }
    });
    b.on('death', () => {
      lastReflex = 0; // a fresh life deserves a fresh reflex
      hungerArmed = true; // respawn resets food to 20; the next slide is a new episode
      // Grab the position NOW — after respawn the entity stands at the spawn
      // point and the death spot is gone. Persist it too: 'where did I die?'
      // must survive a process restart, and a hired worker can run the
      // corpse-run while the primary keeps working.
      const p = b.entity?.position;
      console.log(`💀 died${p ? ` at ${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}` : ''}`);
      let where = 'position unknown — it happened before spawn finished';
      // #35: soak36 died three times at (1,67,30) and the note was identical
      // each time, because 'last_death' is a NAME and writePlace replaces a
      // name — every death erased the proof the last one happened here. The
      // count comes back out of the store, not out of this handler.
      const site = p
        ? recordDeath(p, {
            dimension: b.game?.dimension,
            // #35's remedy half: the conditions, so a cluster can name what its
            // deaths SHARE (no armour, after dark, the same job) instead of only
            // counting them.
            ...deathContext(b, { doing: journeys.running?.goal }),
          })
        : undefined;
      // A fact that only ever reaches the mind cannot be verified by anyone
      // else. soak38 detected three repeat graves and the log said nothing about
      // any of them, so the rail was indistinguishable from the silent one it
      // replaced — the same auditability lesson as c90b087.
      if (site?.repeat) console.log(`💀 [grave] ${site.fact}`);
      if (p) {
        const place = writePlace('last_death', p, `died here (${b.game?.dimension ?? 'unknown dimension'})`, b.username ?? 'bot');
        where = `at (${place.x}, ${place.y}, ${place.z}) in ${b.game?.dimension ?? '?'} — saved as waypoint 'last_death'`;
      }
      // Same rule as onRevive: never push into a possibly-mid-turn history.
      recordTurnEvent('died');
      // #46: after a respawn the hands are EMPTY by definition — saying so with
      // the bag's contents is the difference between "think about what killed
      // you" and knowing you are about to walk back out unarmed.
      const armed = readArmed(b);
      // #35: on a REPEAT grave the stock advice contradicts the fact printed one
      // sentence later. "Run back (or hire a worker for the corpse-run)" is what
      // sent Rescue 0-for-2 into the airspace that had already killed the bot,
      // while the site fact says the earlier piles have despawned. So the advice
      // is not suppressed by a policy the mind cannot see — it is replaced by the
      // arithmetic: only THIS life's drops still exist, and they are lying inside
      // the thing that has killed us N times.
      const corpseAdvice = site?.repeat
        ? `Only THIS life's drops are still there — the ${site.repeat.count - 1} earlier pile(s) at this spot are gone — and they are lying inside whatever has killed you ${site.repeat.count} times, so a corpse-run here is a re-entry, not an errand.`
        : 'Run back (or hire a worker for the corpse-run) — and think about what killed you before walking into it again.';
      queueNote(`(system) You DIED and respawned. ${armed.line} Your items are on the ground ${where} and despawn in ~5 minutes. ${corpseAdvice}${site?.fact ? ` ${site.fact}` : ''}`);
      // Spoken to a human, so it must not promise a decision the mind has not
      // made: "heading back for them" was a plan invented by the death handler,
      // and soak24 shows what actually followed a death — four more bare-fisted
      // bursts against the same phantoms, nowhere near the drop pile. Say the
      // facts (where, the clock, and that the hands are empty now) and let the
      // mind announce its own plan.
      voiceBridge.push('sentinel', `I just DIED ${where}. My gear is in that pile and despawns in about five minutes, and I respawned ${armed.armed ? `holding a ${armed.held}` : 'empty-handed'}.${site?.repeat ? ` That is death number ${site.repeat.count} within ${site.repeat.radius} blocks of the same spot.` : ''}`, 2);
    });
  });

  // Rail 7: the sentinel — event-driven senses (whitelisted hearing, hostile
  // radar on a 1s poll, day/night clock, social presence, base security
  // around saved waypoints, vitals). Pure code; the model hears edge-triggered
  // notes on the same queue as deaths/reconnects, and the can't-wait cases
  // (primed creeper, drowning, melee-range hostile) come through the same
  // reflexRun gate as pain.
  const sentinel = startSentinel(body, {
    // Our own hires are trusted by name, live: a worker's whole job is to dig
    // (live soak — 'Digger is BREAKING spruce_log near loot_chest').
    ownWorkers: () => fleet.list()
      .filter((w) => w.status === 'working' || w.status === 'connecting')
      .map((w) => w.name),
    note: (text) => {
      queueNote(text);
      // Base security is the one note-class event a player away from the
      // keyboard would want SPOKEN — someone is at their chests/walls.
      if (/just OPENED|is BREAKING|is STILL digging/.test(text)) voiceBridge.push('sentinel', text, 2);
    },
    reflex: (name, prompt) => {
      // Urgent danger deserves voice even when the reflex gate is mid-cooldown
      // — the bridge dedupes repeats, the gate only guards model turns.
      voiceBridge.push('sentinel', prompt, 2);
      reflexRun(name, prompt);
    },
    log: (who, text) => { console.log(`👂 ${text}`); web?.log('system', who, text); },
  });

  // Rail 8: the spinal cord — LLM-free survival reflexes on a 300ms tick.
  // Safety modes (lava, dying, creepers, stuck) act first and report after
  // via ONE digest note; idle modes (eat/armor/loot/gaze) only run when no
  // turn is in flight and the pathfinder is free — housekeeping never
  // fights the mind for the legs.
  // Bind the process lock to THIS body, so the tools' walks (which look their
  // lock up by body) arbitrate against the reflexes' claims — same legs, same
  // lock. Workers register their own; a flee in one body must not freeze another.
  registerLegs(body, legs);
  const reflexes = startReflexes(body, {
    deliberateBusy: () => session.busy > 0,
    note: queueNote,
    legs, // the primary body's legs — shared with whatever else sets goals
    log: (who, text) => { console.log(`⚡ ${text}`); web?.log('system', who, text); },
  });

  // 📈 The memory probe (issue #44): the bot reached V8's 4GB default cap after
  // 51 minutes and died on a 4.3s scavenge that reclaimed 5MB of 4050MB — pure
  // retention. Every long-lived collection registers its SIZE under its own
  // name here, so the soak log names the structure that grows instead of only
  // proving that something does. Registration lives at the wiring point, not
  // inside each rail: the rails stay ignorant of the probe.
  // The second argument is an ALARM threshold, not a behaviour knob: it says
  // "past here this structure is misbehaving", and it is deliberately generous
  // (a view distance of 10 loads ~441 columns, so 2000 is a leak, not a busy
  // day). Diagnostics live next to the registration; nothing in the bot's
  // conduct changes when one trips, it just gets named out loud, once.
  memoryProbe.track('history.messages', () => session.messages.length, 400);
  memoryProbe.track('notes.queue', () => pendingNotes.stats().pending, pendingNotes.stats().cap);
  memoryProbe.track('voice.queue', () => voiceBridge.pending(), voiceBridge.cap);
  memoryProbe.track('journeys.all', () => journeys.list().length, 100);
  memoryProbe.track('journeys.ledger', () => {
    const l = journeys.ledger();
    return l.completed.length + l.tooHard.length;
  });
  memoryProbe.track('fleet.workers', () => fleet.list().length, 50);
  // The #44 tell: bodies is the LIVE crew, so census.bots.alive tends to
  // bodies + 1 (the primary). Read the GAP, not the equality — census counts
  // through WeakRefs, so a released body stays "alive" until a GC gets to it
  // (harmless: releaseBot already took its world). A gap that GROWS is the
  // leak; a gap that comes and goes is just uncollected garbage.
  memoryProbe.track('fleet.bodies', () => fleet.bodies, 20);
  // What the crew costs in chunks — the per-worker view budget is visible here
  // or nowhere (issue #44).
  memoryProbe.track('fleet.columns', () => fleet.columns, 4_000);
  // WeakRef censuses: one retained Bot is worth thousands of map entries.
  memoryProbe.track('census.bots.alive', () => census.alive('bots'), 8);
  memoryProbe.track('census.bots.created', () => census.created('bots'));
  // Every fork is an Agent with a seeded history whose tools close over a bot.
  memoryProbe.track('census.agents.alive', () => census.alive('agents'), 20);
  memoryProbe.track('census.agents.created', () => census.created('agents'));
  // The world the CURRENT body holds. `bot.world` is prismarine-world's SYNC
  // wrapper — the column store is one level down on `.async`, and reading the
  // wrong level reports a confident 0 forever (my first probe did exactly that).
  // A chunk column is hundreds of KB, so a count that only climbs is a chunk
  // leak worth GBs; mineflayer is supposed to drop them on unload_chunk.
  memoryProbe.track('world.columns', () => {
    const w = bot.world as unknown as { async?: { columns?: object }; columns?: object };
    return Object.keys(w.async?.columns ?? w.columns ?? {}).length;
  }, 2_000);
  memoryProbe.track('world.entities', () => Object.keys(bot.entities ?? {}).length, 2_000);
  // Listener counts: every handler closure retains whatever it captured, so a
  // rail that re-wires without removing is both a leak and a duplicate-work bug.
  memoryProbe.track('bot.listeners', () => listenerTotal(bot as unknown as EmitterLike), 300);
  memoryProbe.track('client.listeners', () => listenerTotal((bot as unknown as { _client?: EmitterLike })._client), 400);
  for (const [name, size] of Object.entries(sentinel?.sizes() ?? {})) {
    memoryProbe.track(name, () => sentinel?.sizes()[name] ?? size);
  }
  for (const [name, size] of Object.entries(reflexes?.sizes() ?? {})) {
    memoryProbe.track(name, () => reflexes?.sizes()[name] ?? size);
  }
  for (const [name, size] of Object.entries(web?.sizes() ?? {})) {
    memoryProbe.track(name, () => web?.sizes()[name] ?? size);
  }
  memoryProbe.start(
    (line, level) => {
      if (level === 'warn') console.error(`🚨 ${line}`); else console.log(`🧮 ${line}`);
      web?.log('system', 'health', line);
    },
    cfg.memcheck.probeIntervalMs,
    heapLimitMb(),
  );

  // The world digest — one compact status block assembled from what the
  // rails already know (sentinel radar, reflex log, journeys, fleet). Every
  // thinker cycle and journey step opens with it, replacing a "perceive
  // first" tool round-trip with state the process was holding anyway.
  const digestNow = () => worldDigest(bot, {
    threats: () => sentinel?.threats() ?? [],
    reflexRecent: (n) => reflexes?.recent(n) ?? [],
    journey: () => {
      const j = journeys.running;
      return j && { id: j.id, goal: j.goal, step: j.iterations, last: j.journal[j.journal.length - 1] };
    },
    workers: () => fleet.list()
      .filter((w) => w.status === 'working' || w.status === 'connecting')
      .map((w) => `${w.name}(${w.status} #${w.steps})`),
  });
  thinker.digest = digestNow;
  journeys.digest = digestNow;
  // A journey step is a turn like any other, so it drains the note rail like
  // any other — otherwise the senses' news waits for a human or an idle window
  // that a running journey never leaves (soak32: 25 armed facts delivered, 130
  // fist swings, 25 deaths).
  journeys.takeNotes = () => takeNotesAudited();
  // Same numbers the digest states, handed to the thinker as VALUES: a bot that
  // cannot heal gets the survival override instead of the focus rotation.
  thinker.vitals = () => ({
    health: bot.health,
    food: bot.food,
    foodPortions: inventoryHighlights(bot.inventory?.items().map((i) => ({ name: i.name, count: i.count })) ?? []).foodPortions,
  });
  // The Δ critic's snapshots: body state before/after each journey step.
  journeys.snapshot = () => {
    if (!bot.entity) return undefined;
    // countCarried, not items(): offhand, armor AND the cursor. Every hole in
    // this count becomes a phantom loss in a Δ line the model is told to trust.
    const inv = countCarried(carriedView(bot));
    const p = bot.entity.position;
    return { pos: { x: p.x, y: p.y, z: p.z }, health: bot.health ?? 20, food: bot.food ?? 20, inv };
  };

  // Rail 4: realtime speech-to-speech — one socket, semantic VAD, barge-in,
  // tools called mid-sentence. The CLI call and the web dashboard's phone
  // call share createVoiceCall (voicecall.ts): same tools, same image
  // interception, same turn absorption — only the audio transport differs.
  let call: RealtimeCall | null = null;
  const voiceToolRoster = () => [...allTools(bot), ...journeyTools(journeys)];

  const startCall = async () => {
    if (call?.live) { console.log('📞 already on a call — "hangup" first.'); return; }
    if (!process.env.OPENAI_API_KEY) { console.log('📞 realtime voice needs OPENAI_API_KEY in .env'); return; }
    call = createVoiceCall({
      apiKey: process.env.OPENAI_API_KEY,
      bot,
      agent,
      tools: voiceToolRoster(),
      touch: () => thinker.touch(),
      onEvent: (e) => {
        if (e.type === 'user_transcript') console.log(`\n🗣  ${e.text}`);
        else if (e.type === 'tool_call') console.log(`  ⚙ ${e.name}(${JSON.stringify(e.args).slice(0, 120)})`);
        else if (e.type === 'turn' && !e.continuation) console.log(`🤖 ${e.assistant}`);
        else if (e.type === 'error') console.error(`📞 ${e.error}`);
        else if (e.type === 'status') console.log(`📞 ${e.status}`);
      },
    });
    await call.start();
    console.log('📞 live — just talk. Interrupt any time. "hangup" to end.');
  };

  // Rail 2: CLI REPL — while (true) session.ask(input). 'v' push-to-talk, 'call' realtime.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => rl.question(isRecording() ? '🎤 recording — "v" + Enter to stop> ' : 'you> ', async (line) => {
    const text = line.trim();
    if (text === 'exit' || text === 'quit') { thinker.stop(); sentinel?.stop(); reflexes?.stop(); loopWatch.stop(); call?.stop(); fleet.retireAll(); web?.close(); body.retire(); process.exit(0); }

    if (text === 'call') {
      try { await startCall(); } catch (err) { console.error(`📞 ${err instanceof Error ? err.message : err}`); }
      return prompt();
    }
    if (text === 'hangup') {
      call?.stop();
      call = null;
      console.log('📞 call ended.');
      return prompt();
    }

    // Rail 3: voice notes — v to start talking, v again to stop → transcribe → agent → speak
    if (text === 'v') {
      try {
        if (!isRecording()) {
          startRecording();
          console.log('🎤 listening… say your command, then "v" + Enter to stop.');
        } else {
          const heard = await stopRecording();
          console.log(`🗣️  heard: "${heard}"`);
          if (heard) void run(heard, { voice: true });
        }
      } catch (err) {
        console.error(`🎤 ${err instanceof Error ? err.message : err}`);
      }
      return prompt();
    }

    // Fire-and-forget: the prompt returns immediately, answers land when ready —
    // send three requests in a row and all three run (fork/fold in session.ts).
    if (text) void run(text);
    prompt();
  });

  console.log('💬 Type to the bot · "v" push-to-talk · "call" realtime voice (barge-in!) · "exit" quits.');
  console.log('⑂  Concurrent: send another request while one runs — it forks the history and folds back.');
  console.log(`🧭 Journeys: "keep mining until you have 64 iron" → start_journey. 💭 Idle thinker: ${process.env.THINKER_DISABLED === 'true' ? 'off (THINKER_DISABLED=true)' : 'on (THINKER_DISABLED=true to disable)'}.`);
  console.log(`👁  Vision: agent can call capture_view (viewer on :${process.env.VIEWER_PORT ?? 3007}).\n`);
  prompt();
  thinker.start();
};

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
