/**
 * Pure, deterministic Snake game engine.
 *
 * No DOM, timers, network or wall-clock access: every transition is a pure
 * function of its inputs and the only randomness is the injectable `rng`.
 * That keeps the rules unit-testable with `node --test`, while the browser
 * layer (`main.mjs`) owns rendering, scheduling and input exclusively.
 */

/** Canonical unit vectors for the four legal directions. */
export const DIRECTIONS = Object.freeze({
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
});

const DEFAULTS = Object.freeze({ width: 21, height: 21, startLength: 4, seed: 1 });

/**
 * Deterministic seeded PRNG (mulberry32). The returned generator always yields
 * values in `[0, 1)`, so a seeded game replays its food placement exactly.
 */
export function mulberry32(seed = DEFAULTS.seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 31);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cellKey = (x, y) => `${x},${y}`;

function occupiedCells(state) {
  const used = new Set(state.snake.map((p) => cellKey(p.x, p.y)));
  if (state.food) used.add(cellKey(state.food.x, state.food.y));
  return used;
}

/** Every grid cell that is free right now, scanned row by row. */
export function freeCells(state) {
  const used = occupiedCells(state);
  const cells = [];
  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      if (!used.has(cellKey(x, y))) cells.push({ x, y });
    }
  }
  return cells;
}

/**
 * Place food on a free cell chosen through `state.rng`. Never selects a cell
 * covered by the snake or by existing food. When the grid has no free cell
 * left the game is won: food is cleared and `status` becomes `'won'`, so
 * callers never spin on an unsatisfiable placement.
 */
export function spawnFood(state) {
  const cells = freeCells(state);
  if (cells.length === 0) {
    if (state.status === 'over') return { ...state, food: null };
    return { ...state, food: null, status: 'won' };
  }
  const index = Math.min(cells.length - 1, Math.floor(state.rng() * cells.length));
  return { ...state, food: cells[index] };
}

/**
 * Build the initial `ready` state: a horizontal snake on the middle row,
 * heading `right`, with food already placed.
 */
export function createGame(options = {}) {
  const width = options.width ?? DEFAULTS.width;
  const height = options.height ?? DEFAULTS.height;
  for (const name of ['width', 'height']) {
    const value = options[name];
    if (value !== undefined && (!Number.isInteger(value) || value < 3)) {
      throw new RangeError(`${name} must be an integer >= 3, got ${value}`);
    }
  }
  const length = Math.max(1, Math.min(options.startLength ?? DEFAULTS.startLength, width));
  const rng = options.rng ?? mulberry32(options.seed);

  const startX = Math.max(length - 1, Math.floor(width / 2));
  const startY = Math.floor(height / 2);
  const snake = [];
  for (let i = 0; i < length; i += 1) snake.push({ x: startX - i, y: startY });

  return spawnFood({
    status: 'ready',
    width,
    height,
    rng,
    snake,
    dir: 'right',
    pendingDir: 'right',
    food: null,
    score: 0,
    ticks: 0,
    startLength: length,
  });
}

const LOWER_DIRECTION = Object.freeze(
  Object.keys(DIRECTIONS).reduce((acc, name) => ({ ...acc, [name.toLowerCase()]: name }), {}),
);

/** Accepts direction names in any casing (`'up'`, `'Up'`, `'UP'`). */
export function normalizeDirection(name) {
  if (typeof name !== 'string') return null;
  return LOWER_DIRECTION[name.toLowerCase()] ?? null;
}

const isOpposite = (a, b) => {
  const [ax, ay] = DIRECTIONS[a];
  const [bx, by] = DIRECTIONS[b];
  return ax === -bx && ay === -by;
};

/**
 * Queue a direction change for the next tick. Rejected (state returned
 * unchanged) when the name is unknown, equals the live direction, or is its
 * exact 180-degree reversal. The guard compares against the currently applied
 * `dir`, so two presses inside one tick can never compound into a reversal.
 */
export function queueDirection(state, name) {
  if (state.status === 'over' || state.status === 'won') return state;
  const next = normalizeDirection(name);
  if (!next || next === state.dir || isOpposite(state.dir, next)) return state;
  return { ...state, pendingDir: next };
}

/**
 * Advance the game by exactly one tick. A `ready` game starts moving;
 * `paused`, `over` and `won` games are inert and returned unchanged.
 *
 * Ordering is the classic Snake rule set: commit the queued direction, move
 * the head, reject wall and self collisions, then grow (no tail pop) when the
 * head enters the food cell. The vacated tail cell is safe to enter.
 */
export function step(state) {
  if (state.status !== 'running' && state.status !== 'ready') return state;

  const dir = state.pendingDir;
  const [dx, dy] = DIRECTIONS[dir];
  const head = state.snake[0];
  const next = { x: head.x + dx, y: head.y + dy };

  if (next.x < 0 || next.y < 0 || next.x >= state.width || next.y >= state.height) {
    return { ...state, dir, status: 'over' };
  }

  const body = state.snake.slice(0, -1);
  if (body.some((p) => p.x === next.x && p.y === next.y)) {
    return { ...state, dir, status: 'over' };
  }

  // Growing keeps the tail cell for this tick; the tail is consumed by the
  // next move instead, which is what makes the snake lengthen by one.
  const ate = state.food !== null && next.x === state.food.x && next.y === state.food.y;
  const ticked = {
    ...state,
    dir,
    snake: ate ? [next, ...state.snake] : [next, ...body],
    ticks: state.ticks + 1,
    status: 'running',
  };

  if (!ate) return ticked;
  return spawnFood({ ...ticked, score: state.score + 1 });
}

/** Begin (or resume) play. */
export function start(state) {
  if (state.status === 'ready' || state.status === 'paused') return { ...state, status: 'running' };
  return state;
}

/** Freeze ticking without losing progress. */
export function pause(state) {
  return state.status === 'running' ? { ...state, status: 'paused' } : state;
}

/** Toggle between `running` and `paused`, starting a `ready` game. */
export function togglePause(state) {
  if (state.status === 'ready') return start(state);
  if (state.status === 'paused') return start(state);
  return pause(state);
}

/** Fresh game on the same grid and rng, so play can continue immediately. */
export function restart(state) {
  return createGame({
    width: state.width,
    height: state.height,
    startLength: state.startLength,
    rng: state.rng,
  });
}

/** True once the game finished, by collision or by filling the grid. */
export function isOver(state) {
  return state.status === 'over' || state.status === 'won';
}

/** Fixed-timestep cadence in milliseconds; mildly faster as the score grows. */
export function stepMsFor(score, baseMs = 110) {
  return Math.max(70, baseMs - Math.floor(score / 5) * 5);
}

