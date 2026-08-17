// One-off probe (issue #34a): what mineflayer's own digTime says a block costs by tool, dry vs underwater.
// Not part of the app or the tests — `node scripts/probes/probe-digprice.mjs`.
const registry = (await import('prismarine-registry')).default('1.21.4');
const Block = (await import('prismarine-block')).default(registry);
const stone = registry.blocksByName.stone;
const b = new Block(stone.id, 0, 0);
const pick = (n) => registry.itemsByName[n]?.id ?? null;
for (const [label, t] of [['fist', null], ['wooden_pickaxe', pick('wooden_pickaxe')], ['stone_pickaxe', pick('stone_pickaxe')], ['iron_pickaxe', pick('iron_pickaxe')]]) {
  const dry = b.digTime(t, false, false, false);
  const wet = b.digTime(t, false, true, true);
  console.log(label.padEnd(15), 'dry', (dry/1000).toFixed(2)+'s', ' underwater+offground', (wet/1000).toFixed(2)+'s');
}
