/**
 * One-off probe (issue #34) — not part of the app or the tests; kept as evidence.
 * LIVE PROBE — #34's ceiling reader, against the real world.
 *
 * A second, empty-handed body joins the same server the soak bot is in, finds
 * real water, and runs OUR OWN exported waterColumn / lateralAirColumn /
 * gradeEvacuation over the real blocks. Run from INSIDE the repo (a script in
 * /tmp cannot resolve mineflayer):
 *
 *   MC_HOST=127.0.0.1 npx tsx scripts/probes/probe-ceiling.mts
 */
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { waterColumn, lateralAirColumn, gradeEvacuation, shoreDirection } from '../../src/tools/helpers.js';

const bot = mineflayer.createBot({
  host: process.env.MC_HOST ?? '127.0.0.1',
  port: Number(process.env.MC_PORT ?? 25565),
  username: 'CeilingProbe',
  auth: 'offline',
  version: process.env.MC_VERSION,
});

const done = (code: number) => { try { bot.quit(); } catch {} setTimeout(() => process.exit(code), 500); };
setTimeout(() => { console.log('PROBE TIMEOUT'); done(1); }, 90_000);

bot.once('spawn', async () => {
  await new Promise((r) => setTimeout(r, 6_000)); // let chunks load
  const blockNameAt = (x: number, y: number, z: number) => bot.blockAt(new Vec3(x, y, z))?.name;
  const me = bot.entity.position;
  console.log('POS', me.x.toFixed(1), me.y.toFixed(1), me.z.toFixed(1));

  // 1. The column over the probe's own head, wherever it landed.
  console.log('OWN COLUMN', JSON.stringify(waterColumn(me, blockNameAt)));

  // 2. Real water nearby, and the column read from INSIDE it — the case that
  //    killed the bot: a submerged body deciding whether up is a direction.
  const water = bot.findBlock({ matching: (b) => b?.name === 'water', maxDistance: 64 });
  if (!water) { console.log('NO WATER within 64 — nothing to price'); return done(0); }
  const wp = water.position;
  console.log('WATER at', wp.toString(), 'dist', me.distanceTo(wp).toFixed(1));

  for (const dy of [0, -1, -2]) {
    const feet = new Vec3(wp.x, wp.y + dy, wp.z);
    if (blockNameAt(feet.x, feet.y, feet.z) !== 'water') continue;
    const col = waterColumn(feet, blockNameAt);
    const exit = col.kind === 'blocked' ? lateralAirColumn(feet, blockNameAt, 8) : undefined;
    const shore = shoreDirection(feet, blockNameAt, 16);
    const headBlk = bot.blockAt(new Vec3(feet.x, feet.y + 1, feet.z)) as { name?: string; boundingBox?: string } | null;
    const verdict = gradeEvacuation({
      headClear: headBlk?.name !== 'water',
      headBlock: headBlk?.name,
      headSealed: headBlk?.boundingBox === 'block',
      feetInWater: true,
      standingOnSolid: false,
      movedBlocks: 10,
      attempt: 1,
      column: col,
      lateralExit: !!exit,
    });
    console.log(`FROM ${feet.toString()} COLUMN ${JSON.stringify(col)} EXIT ${JSON.stringify(exit)} SHORE ${JSON.stringify(shore)}`);
    console.log(`  VERDICT next=${verdict.next} :: ${verdict.grade}`);
  }

  // 2b. DIVE: walk into that water and run the whole chain on a REAL submerged
  //     body — the read-back that soak42 could only do by dying.
  if (process.env.PROBE_DIVE === '1') {
    const target = new Vec3(wp.x + 0.5, wp.y + 0.5, wp.z + 0.5);
    const deadline = Date.now() + 30_000;
    const feetName = () => blockNameAt(Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z));
    while (Date.now() < deadline && feetName() !== 'water') {
      await bot.lookAt(target, true);
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      await new Promise((r) => setTimeout(r, 400));
      if (bot.entity.position.distanceTo(target) < 1.2) break;
    }
    bot.clearControlStates();
    await new Promise((r) => setTimeout(r, 1_200));
    const p2 = bot.entity.position;
    const fx = Math.floor(p2.x), fy = Math.floor(p2.y), fz = Math.floor(p2.z);
    const headBlk = bot.blockAt(new Vec3(fx, fy + 1, fz)) as { name?: string; boundingBox?: string } | null;
    const below = blockNameAt(fx, fy - 1, fz);
    const isWater = (n?: string) => n === 'water' || n === 'flowing_water' || n === 'bubble_column';
    const col = waterColumn(p2, blockNameAt);
    const exit = col.kind === 'blocked' ? lateralAirColumn(p2, blockNameAt, 8) : undefined;
    const v = gradeEvacuation({
      headClear: !isWater(headBlk?.name ?? undefined),
      headBlock: headBlk?.name, headSealed: headBlk?.boundingBox === 'block',
      feetInWater: isWater(blockNameAt(fx, fy, fz)),
      standingOnSolid: !!below && !isWater(below) && below !== 'air' && below !== 'cave_air',
      movedBlocks: 0, attempt: 1, column: col, lateralExit: !!exit,
    });
    console.log(`DIVE BODY at ${fx},${fy},${fz} feet=${blockNameAt(fx, fy, fz)} head=${headBlk?.name}/${headBlk?.boundingBox} below=${below} oxygen=${bot.oxygenLevel}`);
    console.log(`DIVE COLUMN ${JSON.stringify(col)} EXIT ${JSON.stringify(exit)}`);
    console.log(`DIVE VERDICT escaped=${v.escaped} next=${v.next} :: ${v.grade}`);
  }

  // 3. A SEALED case on purpose: one block under a real solid block, so the
  //    'blocked' arm is exercised on real terrain rather than a fake world.
  const solid = bot.findBlock({ matching: (b) => !!b && !['air', 'cave_air', 'water', 'void_air'].includes(b.name), maxDistance: 24 });
  if (solid) {
    const under = new Vec3(solid.position.x, solid.position.y - 1, solid.position.z);
    const col = waterColumn(under, blockNameAt);
    console.log(`UNDER ${solid.name} at ${solid.position.toString()} → COLUMN ${JSON.stringify(col)} EXIT ${JSON.stringify(lateralAirColumn(under, blockNameAt, 8))}`);
  }
  done(0);
});

bot.on('error', (e) => { console.log('PROBE ERROR', e.message); done(1); });
bot.on('kicked', (r) => { console.log('PROBE KICKED', String(r)); done(1); });
