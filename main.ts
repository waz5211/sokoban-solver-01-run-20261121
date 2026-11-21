// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Strategy: the level is a 1-wide hallway with 1-4 rooms hanging off it, one
// door per room, and a box pushed out of its room can never come back, so a
// level's push-optimal total is the sum of its rooms' optima. We therefore
// detect the rooms, solve each room independently with a push-optimal A*
// (state = player cell + sorted box cells, cost = pushes), and stitch the
// per-room move strings together with walks along the hallway.
//
// Per-room search details:
//   - Heuristic: exact single-box push distances (boxes ignored) from every
//     cell to every goal, combined by a minimum assignment over box/goal
//     permutations. Admissible, since other boxes can only add pushes.
//   - Deadlock pruning: (a) dead cells, cells from which a box can never
//     reach any goal in the relaxed push graph; (b) frozen boxes, computed
//     to a fixpoint: a box that cannot be pushed in any direction because
//     every target/standing cell is a wall or a frozen box.
//   - A room is usually solved with the extra condition that the player can
//     still reach the hallway afterwards (otherwise the player would be
//     trapped inside a finished room and could not reach the next one). The
//     one room that is solved last does not need that condition. We compute
//     both variants per room and put last the room that gains most from
//     dropping the condition.
//   - Deterministic: no clock, no randomness; all tie-breaking is by
//     insertion order. Work is bounded by an expansion cap, never by time.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions: 0 = up, 1 = down, 2 = left, 3 = right. Opposite of d is d ^ 1.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const CH = ['u', 'd', 'l', 'r'];

interface Level {
  w: number;
  h: number;
  wall: boolean[];
  goal: boolean[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall: boolean[] = new Array(w * h).fill(true);
  const goal: boolean[] = new Array(w * h).fill(false);
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = rows[y][x] ?? '#';
      const i = y * w + x;
      if (c === '#') continue;
      wall[i] = false;
      if (c === '.' || c === '*' || c === '+') goal[i] = true;
      if (c === '$' || c === '*') boxes.push(i);
      if (c === '@' || c === '+') player = i;
    }
  }
  return { w, h, wall, goal, boxes, player };
}

// Small binary heap ordered by (f, h, insertion counter).
class Heap {
  a: { f: number; h: number; c: number; ni: number }[] = [];
  get size(): number { return this.a.length; }
  push(v: { f: number; h: number; c: number; ni: number }): void {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cmp(a[i], a[p]) >= 0) break;
      const t = a[i]; a[i] = a[p]; a[p] = t;
      i = p;
    }
  }
  pop(): { f: number; h: number; c: number; ni: number } {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        const t = a[i]; a[i] = a[m]; a[m] = t;
        i = m;
      }
    }
    return top;
  }
}
function cmp(x: { f: number; h: number; c: number }, y: { f: number; h: number; c: number }): number {
  if (x.f !== y.f) return x.f - y.f;
  if (x.h !== y.h) return x.h - y.h;
  return x.c - y.c;
}

interface RoomSol {
  moves: string;
  pushes: number;
  endPlayer: number;
}

interface SolverCtx {
  lv: Level;
  region: Set<number>;   // cells boxes may occupy (the room, or the whole floor)
  walkable: Set<number>; // cells the player may walk on (region + hallway)
  hallway: Set<number>;  // hallway cells (for the exit test)
  goals: number[];
  goalSet: Set<number>;
  distFromGoal: Map<number, number>[]; // per goal: cell -> min pushes (relaxed)
  dead: Set<number>;     // region cells from which no goal is reachable
}

function makeCtx(lv: Level, regionCells: number[], goals: number[], extraWalkable: Set<number>): SolverCtx {
  const { w, h } = lv;
  const region = new Set(regionCells);
  const walkable = new Set<number>([...regionCells, ...extraWalkable]);
  const goalSet = new Set(goals);
  const step = (c: number, d: number): number => {
    const x = (c % w) + DX[d];
    const y = Math.floor(c / w) + DY[d];
    if (x < 0 || x >= w || y < 0 || y >= h) return -1;
    return y * w + x;
  };
  // Relaxed single-box push distances from each goal, by reverse BFS: a box
  // at c came from p = c - d, pushed in direction d, with the player standing
  // at p - d. The relaxed graph is symmetric, so these are true min-push
  // distances with other boxes ignored.
  const distFromGoal: Map<number, number>[] = goals.map((g) => {
    const dist = new Map<number, number>();
    dist.set(g, 0);
    const q: number[] = [g];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      const dc = dist.get(c)!;
      for (let d = 0; d < 4; d++) {
        const p = step(c, d ^ 1);
        if (p < 0 || !region.has(p) || dist.has(p)) continue;
        const s = step(p, d ^ 1);
        if (s < 0 || !walkable.has(s)) continue;
        dist.set(p, dc + 1);
        q.push(p);
      }
    }
    return dist;
  });
  const dead = new Set<number>();
  for (const c of region) {
    if (goalSet.has(c)) continue;
    let ok = false;
    for (const dm of distFromGoal) if (dm.has(c)) { ok = true; break; }
    if (!ok) dead.add(c);
  }
  return { lv, region, walkable, hallway: extraWalkable, goals, goalSet, distFromGoal, dead };
}

// Minimum-assignment heuristic over the relaxed push distances.
function heuristic(ctx: SolverCtx, boxes: number[]): number {
  const n = boxes.length;
  if (n !== ctx.goals.length) return Infinity;
  const cost: number[][] = boxes.map((b) => ctx.distFromGoal.map((dm) => dm.get(b) ?? Infinity));
  // Brute-force permutations (n <= 4).
  let best = Infinity;
  const used: boolean[] = new Array(n).fill(false);
  const rec = (k: number, sum: number): void => {
    if (sum >= best) return;
    if (k === n) { best = sum; return; }
    for (let g = 0; g < n; g++) {
      if (used[g]) continue;
      const c = cost[k][g];
      if (c === Infinity) continue;
      used[g] = true;
      rec(k + 1, sum + c);
      used[g] = false;
    }
  };
  rec(0, 0);
  return best;
}

// BFS walk for the player from `from` to `to`, treating boxes as obstacles.
// Returns the move string, or null if unreachable.
function walkPath(ctx: SolverCtx, from: number, to: number, boxSet: Set<number>): string | null {
  if (from === to) return '';
  const step = (c: number, d: number): number => {
    const x = (c % ctx.lv.w) + DX[d];
    const y = Math.floor(c / ctx.lv.w) + DY[d];
    if (x < 0 || x >= ctx.lv.w || y < 0 || y >= ctx.lv.h) return -1;
    return y * ctx.lv.w + x;
  };
  const prev = new Map<number, number>();
  const prevCh = new Map<number, string>();
  const q: number[] = [from];
  prev.set(from, -1);
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    for (let d = 0; d < 4; d++) {
      const n = step(c, d);
      if (n < 0 || !ctx.walkable.has(n) || boxSet.has(n) || prev.has(n)) continue;
      prev.set(n, c);
      prevCh.set(n, CH[d]);
      if (n === to) {
        let s = '';
        let cur = n;
        while (cur !== from) { s = prevCh.get(cur)! + s; cur = prev.get(cur)!; }
        return s;
      }
      q.push(n);
    }
  }
  return null;
}

// True when some box (not on a goal) can never move again: every push is
// blocked by a wall or by a box that is itself frozen. Fixpoint, so it is
// sound: a box is only ever blamed on walls or on boxes already proven frozen.
function hasFrozenBox(ctx: SolverCtx, boxes: number[]): boolean {
  const frozen = new Set<number>();
  const step = (c: number, d: number): number => {
    const x = (c % ctx.lv.w) + DX[d];
    const y = Math.floor(c / ctx.lv.w) + DY[d];
    if (x < 0 || x >= ctx.lv.w || y < 0 || y >= ctx.lv.h) return -1;
    return y * ctx.lv.w + x;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of boxes) {
      if (frozen.has(b) || ctx.goalSet.has(b)) continue;
      let canMove = false;
      for (let d = 0; d < 4; d++) {
        const t = step(b, d);
        const s = step(b, d ^ 1);
        // Only walls and already-frozen boxes block forever: a box that is
        // not frozen may move away, so it never counts as a blocker here.
        const tBlocked = t < 0 || !ctx.region.has(t) || frozen.has(t);
        const sBlocked = s < 0 || !ctx.walkable.has(s) || frozen.has(s);
        if (!tBlocked && !sBlocked) { canMove = true; break; }
      }
      if (!canMove) { frozen.add(b); changed = true; }
    }
  }
  return frozen.size > 0;
}

// Can the player, standing at `from`, reach any hallway cell?
function canReachHallway(ctx: SolverCtx, from: number, boxSet: Set<number>): boolean {
  if (ctx.hallway.has(from)) return true;
  if (ctx.hallway.size === 0) return true;
  const step = (c: number, d: number): number => {
    const x = (c % ctx.lv.w) + DX[d];
    const y = Math.floor(c / ctx.lv.w) + DY[d];
    if (x < 0 || x >= ctx.lv.w || y < 0 || y >= ctx.lv.h) return -1;
    return y * ctx.lv.w + x;
  };
  const seen = new Set<number>([from]);
  const q: number[] = [from];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    for (let d = 0; d < 4; d++) {
      const n = step(c, d);
      if (n < 0 || !ctx.walkable.has(n) || boxSet.has(n) || seen.has(n)) continue;
      if (ctx.hallway.has(n)) return true;
      seen.add(n);
      q.push(n);
    }
  }
  return false;
}

const MAX_EXPANSIONS = 2000000;

interface Node {
  player: number;
  boxes: number[];
  parent: number;
  moves: string;
  g: number;
}

// Push-optimal A* for one region. `requireExit`: only accept a solved state
// from which the player can still reach the hallway. Returns null when no
// solution is found within the expansion budget.
function solveRegion(ctx: SolverCtx, initBoxes: number[], playerStart: number, requireExit: boolean): RoomSol | null {
  const { w, h } = ctx.lv;
  const step = (c: number, d: number): number => {
    const x = (c % w) + DX[d];
    const y = Math.floor(c / w) + DY[d];
    if (x < 0 || x >= w || y < 0 || y >= h) return -1;
    return y * w + x;
  };
  const key = (player: number, boxes: number[]): string => `${player}|${boxes.join(',')}`;
  const isGoal = (boxes: number[]): boolean => boxes.every((b) => ctx.goalSet.has(b));

  const startBoxes = [...initBoxes].sort((a, b) => a - b);
  const h0 = heuristic(ctx, startBoxes);
  if (h0 === Infinity) return null;
  const nodes: Node[] = [{ player: playerStart, boxes: startBoxes, parent: -1, moves: '', g: 0 }];
  const heap = new Heap();
  let ctr = 0;
  heap.push({ f: h0, h: h0, c: ctr++, ni: 0 });
  const best = new Map<string, number>();
  best.set(key(playerStart, startBoxes), 0);
  let expansions = 0;

  while (heap.size > 0) {
    const cur = heap.pop();
    const node = nodes[cur.ni];
    if (node.g !== best.get(key(node.player, node.boxes))) continue; // stale entry
    if (isGoal(node.boxes)) {
      if (!requireExit || canReachHallway(ctx, node.player, new Set(node.boxes))) {
        const parts: string[] = [];
        let n: Node | undefined = node;
        while (n && n.parent >= 0) { parts.push(n.moves); n = nodes[n.parent]; }
        parts.reverse();
        return { moves: parts.join(''), pushes: node.g, endPlayer: node.player };
      }
      // Solved but the player is trapped: keep searching for an exit-able
      // solution (this state may still lead somewhere through extra pushes).
    }
    if (++expansions > MAX_EXPANSIONS) return null;
    const boxSet = new Set(node.boxes);
    for (let bi = 0; bi < node.boxes.length; bi++) {
      const b = node.boxes[bi];
      for (let d = 0; d < 4; d++) {
        const t = step(b, d);
        if (t < 0 || !ctx.region.has(t) || boxSet.has(t)) continue;
        const s = step(b, d ^ 1);
        if (s < 0 || !ctx.walkable.has(s) || boxSet.has(s)) continue;
        if (ctx.dead.has(t)) continue;
        const walk = walkPath(ctx, node.player, s, boxSet);
        if (walk === null) continue;
        const nb = [...node.boxes];
        nb[bi] = t;
        nb.sort((a, x) => a - x);
        if (hasFrozenBox(ctx, nb)) continue;
        const hh = heuristic(ctx, nb);
        if (hh === Infinity) continue;
        const g = node.g + 1;
        const k = key(b, nb);
        if (best.has(k) && best.get(k)! <= g) continue;
        best.set(k, g);
        nodes.push({ player: b, boxes: nb, parent: cur.ni, moves: walk + CH[d], g });
        heap.push({ f: g + hh, h: hh, c: ctr++, ni: nodes.length - 1 });
      }
    }
  }
  return null;
}

// Apply a move string to a global (player, boxSet) state. Throws on an
// illegal move, which must never happen for moves we generated ourselves.
function simulate(lv: Level, player: number, boxSet: Set<number>, moves: string): number {
  const { w, h } = lv;
  let p = player;
  for (const ch of moves) {
    const d = CH.indexOf(ch);
    const x = (p % w) + DX[d];
    const y = Math.floor(p / w) + DY[d];
    if (x < 0 || x >= w || y < 0 || y >= h) throw new Error('walk out of bounds');
    const n = y * w + x;
    if (lv.wall[n]) throw new Error('walk into wall');
    if (boxSet.has(n)) {
      const tx = x + DX[d];
      const ty = y + DY[d];
      if (tx < 0 || tx >= w || ty < 0 || ty >= h) throw new Error('push out of bounds');
      const t = ty * w + tx;
      if (lv.wall[t] || boxSet.has(t)) throw new Error('push into wall or box');
      boxSet.delete(n);
      boxSet.add(t);
    }
    p = n;
  }
  return p;
}

// Walk the player from `from` to `to` over all floor cells, boxes as obstacles.
function globalWalk(lv: Level, from: number, to: number, boxSet: Set<number>): string | null {
  const { w, h } = lv;
  if (from === to) return '';
  const step = (c: number, d: number): number => {
    const x = (c % w) + DX[d];
    const y = Math.floor(c / w) + DY[d];
    if (x < 0 || x >= w || y < 0 || y >= h) return -1;
    return y * w + x;
  };
  const prev = new Map<number, number>();
  const prevCh = new Map<number, string>();
  const q: number[] = [from];
  prev.set(from, -1);
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    for (let d = 0; d < 4; d++) {
      const n = step(c, d);
      if (n < 0 || lv.wall[n] || boxSet.has(n) || prev.has(n)) continue;
      prev.set(n, c);
      prevCh.set(n, CH[d]);
      if (n === to) {
        let s = '';
        let cur = n;
        while (cur !== from) { s = prevCh.get(cur)! + s; cur = prev.get(cur)!; }
        return s;
      }
      q.push(n);
    }
  }
  return null;
}

interface Room {
  cells: number[];
  boxes: number[];
  goals: number[];
  door: number;      // the room cell adjacent to the hallway
  entry: number;     // the hallway cell adjacent to the door
}

function solveLevel(lv: Level): string {
  const { w, h } = lv;
  const hallwayRow = Math.floor(lv.player / w);
  const hallway = new Set<number>();
  for (let x = 0; x < w; x++) {
    const c = hallwayRow * w + x;
    if (!lv.wall[c]) hallway.add(c);
  }
  // Connected components of floor cells outside the hallway row: the rooms.
  const seen = new Set<number>();
  const rooms: Room[] = [];
  for (let c = 0; c < w * h; c++) {
    if (lv.wall[c] || Math.floor(c / w) === hallwayRow || seen.has(c)) continue;
    const cells: number[] = [];
    const q: number[] = [c];
    seen.add(c);
    while (q.length > 0) {
      const cur = q.pop()!;
      cells.push(cur);
      const x = cur % w;
      const y = Math.floor(cur / w);
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const n = ny * w + nx;
        if (lv.wall[n] || ny === hallwayRow || seen.has(n)) continue;
        seen.add(n);
        q.push(n);
      }
    }
    const boxes = cells.filter((cc) => lv.boxes.includes(cc));
    const goals = cells.filter((cc) => lv.goal[cc]);
    // Door: the room cell adjacent to a hallway cell (exactly one per room).
    let door = -1;
    let entry = -1;
    for (const cc of cells) {
      const x = cc % w;
      const y = Math.floor(cc / w);
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const n = ny * w + nx;
        if (hallway.has(n)) { door = cc; entry = n; break; }
      }
      if (door >= 0) break;
    }
    rooms.push({ cells, boxes, goals, door, entry });
  }
  // Sanity: every box and every goal must sit inside exactly one room, and
  // every room must have a door and as many goals as boxes. Otherwise fall
  // back to solving the whole level as one region.
  const inRooms = new Set<number>();
  for (const r of rooms) for (const c of r.cells) inRooms.add(c);
  const structured =
    rooms.length >= 1 &&
    rooms.every((r) => r.door >= 0 && r.boxes.length > 0 && r.boxes.length === r.goals.length) &&
    lv.boxes.every((b) => inRooms.has(b)) &&
    lv.goal.every((g, i) => !g || inRooms.has(i));
  if (!structured) {
    const allFloor: number[] = [];
    for (let c = 0; c < w * h; c++) if (!lv.wall[c]) allFloor.push(c);
    const allGoals: number[] = [];
    for (let c = 0; c < w * h; c++) if (lv.goal[c]) allGoals.push(c);
    const ctx = makeCtx(lv, allFloor, allGoals, new Set<number>());
    const sol = solveRegion(ctx, lv.boxes, lv.player, false);
    return sol ? sol.moves : '';
  }

  // Deterministic room order: by smallest cell.
  rooms.sort((a, b) => Math.min(...a.cells) - Math.min(...b.cells));

  // Solve every room twice from its door entry: once requiring the player to
  // still reach the hallway afterwards, once without. Pick the room that
  // gains most from dropping the condition to be solved last.
  interface RoomPlan { room: Room; exit: RoomSol | null; free: RoomSol | null; }
  const plans: RoomPlan[] = [];
  for (const room of rooms) {
    const ctx = makeCtx(lv, room.cells, room.goals, hallway);
    const exit = solveRegion(ctx, room.boxes, room.entry, true);
    const free = solveRegion(ctx, room.boxes, room.entry, false);
    plans.push({ room, exit, free });
  }
  // If a room has no solution at all, the level cannot be solved.
  if (plans.some((p) => p.free === null)) return '';
  let lastIdx = 0;
  let bestGain = -1;
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    // A room with no exit-able solution must go last (huge gain).
    const gain = p.exit === null ? 1000000 : p.exit.pushes - p.free!.pushes;
    if (gain > bestGain) { bestGain = gain; lastIdx = i; }
  }
  const order = plans.map((_, i) => i).filter((i) => i !== lastIdx);
  order.push(lastIdx);

  // Stitch: walk to each room's entry, then play its solution.
  let player = lv.player;
  const boxSet = new Set(lv.boxes);
  let moves = '';
  for (const oi of order) {
    const p = plans[oi];
    const sol = oi === lastIdx ? p.free! : (p.exit ?? p.free!);
    const walk = globalWalk(lv, player, p.room.entry, boxSet);
    if (walk === null) return '';
    moves += walk;
    player = simulate(lv, player, boxSet, walk);
    moves += sol.moves;
    player = simulate(lv, player, boxSet, sol.moves);
  }
  return moves;
}

function solve(text: string): string {
  try {
    return solveLevel(parseLevel(text));
  } catch {
    return '';
  }
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
