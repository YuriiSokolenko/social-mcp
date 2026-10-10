// Deterministic Snake rules for the pack-20261010-rerun3 smoke pack.
//
// This module owns the game rules only: no DOM, timers, or network, and every
// random choice comes from an injectable generator, so `node --test` can
// import it directly and replay a board exactly. Rendering, input, and the
// animation loop live in `main.mjs`.
//
// State is a plain object, treated as immutable: a transition returns a new
// object, or the very same object when the transition is a no-op.
//
//   width, height   grid size in cells
//   snake           occupied cell keys, head first
//   direction       { dx, dy } consumed by the next tick
//   pending         queued { dx, dy } for the next tick, or null
//   food            cell key, or null when the grid is full
//   score           food eaten so far
//   ticks           accepted ticks
//   status          'ready' | 'running' | 'paused' | 'over'
//   outcome         null | 'win' | 'wall' | 'self'
//   rng             () => number in [0, 1)
//   foodFactory     (state) => cell key | null
//   options         creation options, reused verbatim by restart()

export const DIRECTIONS = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

export const COLS = 21;
export const ROWS = 21;
export const START_LENGTH = 3;

export function cellKey(x, y) {
  return `${x},${y}`;
}

export function cellCoords(cell) {
  const comma = cell.indexOf(',');
  return { x: Number(cell.slice(0, comma)), y: Number(cell.slice(comma + 1)) };
}

/** Deterministic mulberry32 generator: one seed always replays one board. */
export function createRng(seed = 1) {
  let a = (Number(seed) >>> 0) || 1;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function freeCells(state) {
  const taken = new Set(state.snake);
  const cells = [];
  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      const cell = cellKey(x, y);
      if (!taken.has(cell)) cells.push(cell);
    }
  }
  return cells;
}

/**
 * Choose a uniform random free cell, or null when the snake fills the grid.
 * Candidates are materialised once, so placement is bounded on a nearly full
 * board and can never land on the snake.
 */
export function placeFood(state) {
  const cells = freeCells(state);
  if (cells.length === 0) return null;
  const index = Math.min(cells.length - 1, Math.floor(state.rng() * cells.length));
  return cells[index];
}

function initialSnake(width, height) {
  const y = Math.floor(height / 2);
  const x = Math.floor(width / 2);
  const cells = [];
  for (let i = 0; i < START_LENGTH; i += 1) cells.push(cellKey(x - i, y));
  return cells;
}

/**
 * Build the opening state. `rng` and `placeFood` are injectable so tests pin
 * food placement; the first food goes through the same factory as later ones.
 */
export function createGame(options = {}) {
  const width = options.width ?? COLS;
  const height = options.height ?? ROWS;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3) {
    throw new RangeError('snake grid must be an integer of at least 3x3 cells');
  }
  const state = {
    width,
    height,
    snake: initialSnake(width, height),
    direction: { ...DIRECTIONS.right },
    pending: null,
    food: null,
    score: 0,
    ticks: 0,
    status: 'ready',
    outcome: null,
    rng: options.rng ?? createRng(options.seed ?? 1),
    foodFactory: options.placeFood ?? placeFood,
    options,
  };
  return { ...state, food: state.foodFactory(state) ?? null };
}

export function isOver(state) {
  return state.status === 'over';
}

function normalizeDirection(next) {
  if (typeof next === 'string') {
    const named = DIRECTIONS[next];
    return named ? { ...named } : null;
  }
  if (next && Number.isFinite(next.dx) && Number.isFinite(next.dy)) {
    return { dx: next.dx, dy: next.dy };
  }
  return null;
}

/**
 * Queue a turn for the next tick. Accepts a DIRECTIONS name or { dx, dy }.
 * The reversal rule is checked against the direction the snake is actually
 * travelling (`pending` when set), so two keypresses inside one tick can
 * never fold the head back into its own body.
 */
export function queueDirection(state, next) {
  if (state.status === 'over') return state;
  const wanted = normalizeDirection(next);
  if (!wanted) return state;
  const travelling = state.pending ?? state.direction;
  if (wanted.dx === travelling.dx && wanted.dy === travelling.dy) return state;
  if (wanted.dx === -travelling.dx && wanted.dy === -travelling.dy) return state;
  return { ...state, pending: wanted };
}

export function start(state) {
  return state.status === 'over' ? state : { ...state, status: 'running' };
}

export function pause(state) {
  return state.status === 'running' ? { ...state, status: 'paused' } : state;
}

export function resume(state) {
  return state.status === 'paused' ? { ...state, status: 'running' } : state;
}

/** A fresh, already running board that keeps the grid and injected seams. */
export function restart(state) {
  return start(createGame(state?.options ?? {}));
}

function inGrid(state, point) {
  return point.x >= 0 && point.x < state.width && point.y >= 0 && point.y < state.height;
}

/**
 * Advance the snake by exactly one cell. Returns the state untouched unless
 * it is running, so a paused or finished board cannot be stepped by accident.
 */
export function step(state) {
  if (state.status !== 'running') return state;
  const direction = state.pending ? { ...state.pending } : { ...state.direction };
  const base = { ...state, direction, pending: null, ticks: state.ticks + 1 };

  const head = cellCoords(state.snake[0]);
  const target = cellKey(head.x + direction.dx, head.y + direction.dy);
  if (!inGrid(state, cellCoords(target))) {
    return { ...base, status: 'over', outcome: 'wall' };
  }

  const ate = state.food !== null && state.food === target;
  // The tail cell is freed by this same move, so entering it is survivable.
  const body = ate ? state.snake : state.snake.slice(0, -1);
  if (body.includes(target)) {
    return { ...base, status: 'over', outcome: 'self' };
  }

  const snake = [target, ...body];
  if (!ate) return { ...base, snake };

  const grew = { ...base, snake, score: state.score + 1 };
  const food = grew.foodFactory(grew);
  // No free cell left after a meal: the grid is full, which is a win.
  if (food === null) return { ...grew, food: null, status: 'over', outcome: 'win' };
  return { ...grew, food };
}

/** Advance up to `count` ticks, stopping early when the board is not running. */
export function run(state, count = 1) {
  let current = state;
  for (let i = 0; i < count; i += 1) {
    const next = step(current);
    if (next === current) break;
    current = next;
    if (current.status === 'over') break;
  }
  return current;
}
