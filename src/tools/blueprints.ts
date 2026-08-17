/**
 * 📐 Parametric blueprints — geometry the model shouldn't hand-author.
 *
 * build_blueprint executes any plan, but asking a language model to emit 60
 * exact {dx,dy,dz,item} triples for a cabin is asking it to be a voxel
 * rasterizer: slow, token-heavy, and one typo'd offset leaves a hole in the
 * roof. These generators produce the common shells deterministically — the
 * agent says "box 5×4×3, door facing south" and gets a correct plan every
 * time. Custom art stays on build_blueprint; walls and boxes belong here.
 *
 * Pure functions, no bot: unit-testable without a server, and the plans they
 * emit are placeable by the executor's ordering by construction: walls rise
 * from the ground layer by layer, and roof interiors — which have nothing
 * below them — propagate horizontally within a pass, because the dy,dx,dz
 * sort means block (x,z) is attempted right after its (x,z-1)/(x-1,z)
 * neighbor landed on the wall top.
 */

export interface PlanBlock {
  dx: number;
  dy: number;
  dz: number;
  item: string;
}

export type Face = 'north' | 'south' | 'east' | 'west';

export interface StructureSpec {
  shape: 'box' | 'wall' | 'floor' | 'pillar';
  item: string;
  /** Footprint x-size (east-west). box/wall/floor. */
  width?: number;
  /** Footprint z-size (north-south). box/floor; wall LENGTH runs along x for door-less walls. */
  depth?: number;
  /** y-size. box/wall/pillar. */
  height?: number;
  /** box only: leave a 1×2 doorway centered on this face (default 'south'). */
  door?: Face | 'none';
  /** box only: add a flat roof layer (default true) and a floor layer (default false). */
  roof?: boolean;
  floor?: boolean;
}

const key = (b: { dx: number; dy: number; dz: number }) => `${b.dx},${b.dy},${b.dz}`;

/**
 * Draft a structure plan. Throws on nonsense dimensions with the limit named,
 * so the agent can correct instead of guessing. Returns the plan plus its
 * material bill — the caller can show the bill (dry run) or hand the blocks
 * straight to the blueprint executor.
 */
export function draftStructure(spec: StructureSpec): { blocks: PlanBlock[]; bill: Record<string, number> } {
  const { shape, item } = spec;
  const dim = (v: number | undefined, fallback: number, name: string, min = 1, max = 32): number => {
    const n = v ?? fallback;
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${shape}: ${name} must be an integer ${min}–${max}, got ${v}`);
    return n;
  };

  const blocks = new Map<string, PlanBlock>();
  const put = (dx: number, dy: number, dz: number) => {
    const b = { dx, dy, dz, item };
    blocks.set(key(b), b); // Map: corners/edges hit twice collapse to one block
  };

  if (shape === 'pillar') {
    const h = dim(spec.height, 3, 'height', 1, 64);
    for (let y = 0; y < h; y++) put(0, y, 0);
  } else if (shape === 'floor') {
    const w = dim(spec.width, 3, 'width');
    const d = dim(spec.depth, 3, 'depth');
    for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) put(x, 0, z);
  } else if (shape === 'wall') {
    const w = dim(spec.width, 5, 'width');
    const h = dim(spec.height, 3, 'height');
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) put(x, y, 0);
  } else if (shape === 'box') {
    const w = dim(spec.width, 5, 'width', 3);
    const d = dim(spec.depth, 5, 'depth', 3);
    const h = dim(spec.height, 3, 'height', 2);
    for (let x = 0; x < w; x++)
      for (let z = 0; z < d; z++)
        for (let y = 0; y < h; y++) {
          const shell = x === 0 || x === w - 1 || z === 0 || z === d - 1;
          if (shell) put(x, y, z);
          else if (y === h - 1 && (spec.roof ?? true)) put(x, y, z);
          else if (y === 0 && (spec.floor ?? false)) put(x, y, z);
        }
    // Doorway: a 1×2 opening centered on the chosen face, at floor level —
    // carved AFTER the shell so the two removed blocks never enter the plan.
    const face = spec.door ?? 'south';
    if (face !== 'none') {
      const cx = Math.floor(w / 2);
      const cz = Math.floor(d / 2);
      const [ox, oz] =
        face === 'south' ? [cx, d - 1] : face === 'north' ? [cx, 0] :
        face === 'east' ? [w - 1, cz] : [0, cz];
      const base = spec.floor ? 1 : 0; // don't carve through our own floor
      for (const dy of [base, base + 1]) blocks.delete(key({ dx: ox, dy, dz: oz }));
    }
  } else {
    throw new Error(`Unknown shape '${shape as string}' — box, wall, floor or pillar.`);
  }

  const list = [...blocks.values()];
  if (!list.length) throw new Error(`${shape}: the plan came out empty — dimensions too small once carved?`);
  const bill: Record<string, number> = {};
  for (const b of list) bill[b.item] = (bill[b.item] ?? 0) + 1;
  return { blocks: list, bill };
}

/**
 * Does a world block satisfy a plan entry? Placement reports and world
 * verification must agree on this, so it lives here — pure and testable.
 * Not just string equality: several ITEMS become differently-named BLOCKS
 * when placed against a wall (torch → wall_torch, oak_sign → oak_wall_sign,
 * skeleton_skull → skeleton_wall_skull, red_banner → red_wall_banner).
 * Exact-name-or-known-wall-variant, never fuzzy — 'oak_planks' satisfying
 * 'oak_plank_stairs' would hide real build damage.
 */
export function blockSatisfies(item: string, blockName: string | undefined): boolean {
  if (!blockName) return false;
  if (blockName === item) return true;
  // The wall variant inserts 'wall_' before the LAST name segment:
  // torch → wall_torch, soul_torch → soul_wall_torch, oak_sign →
  // oak_wall_sign, skeleton_skull → skeleton_wall_skull. Only for the
  // families that actually have wall forms — sign/banner/skull/head/fan
  // and the torches — so plank-vs-stairs damage stays visible.
  const seg = item.slice(item.lastIndexOf('_') + 1);
  if (['torch', 'sign', 'banner', 'skull', 'head', 'fan'].includes(seg)) {
    const idx = item.lastIndexOf('_');
    const wallName = idx === -1 ? `wall_${item}` : `${item.slice(0, idx)}_wall_${item.slice(idx + 1)}`;
    if (blockName === wallName) return true;
  }
  return false;
}
