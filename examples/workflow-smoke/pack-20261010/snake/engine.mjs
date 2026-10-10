/**
 * Pure, deterministic Snake game engine.
 *
 * No DOM, no timers, no network. Every mutating function returns a NEW state
 * object; the incoming state is never modified. Food placement is injectable
 * so tests can control the grid exactly.
 */

export const DIRECTIONS = Object.freeze({
  up: Object.freeze({ dx: 0, dy: -1 }),
  down: Object.freeze({ dx: 0, dy: 1 }),
  left: Object.freeze({ dx: -1, dy: 0 }),
  right: Object.freeze({ dx: 1, dy: 0 }),
});

export const GRID_WIDTH = 20;
export const GRID_HEIGHT = 20;
export const INITIAL_LENGTH = 3;

/** Stable string key for a cell. */
export function key(x, y) {
  return `${x},${y}`;
}

/** Inverse of key(). */
export function parseKey(cellKey) {
  const [x, y] = String(cellKey).split(',').map(Number);
  return { x, y };
}

/**
 * Seedable xorshift32 PRNG. Returns a function producing floats in [0, 1).
 * Deterministic for a given seed.
 */
export function createRng(seed = 1) {
  let state = (Number(seed) >>> 0) || 0x9e3779b9;
  return function next() {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state >>>= 0;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

function isDirection(name) {
  return Object.prototype.hasOwnProperty.call(DIRECTIONS, name);
}

function isOpposite(a, b) {
  const da = DIRECTIONS[a];
  const db = DIRECTIONS[b];
  if (!da || !db) return false;
  return da.dx === -db.dx && da.dy === -db.dy && (da.dx !== 0 || da.dy !== 0);
}

function randomFood(state) {
  const occupied = new Set(state.snake);
  const free = [];
  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      const cell = key(x, y);
      if (!occupied.has(cell)) free.push(cell);
    }
  }
  if (free.length === 0) return null;
  const index = Math.floor(state.rng() * free.length);
  return free[index];
}

/**
 * Place food on a free cell. Enumerates every free cell exactly once (bounded
 * work, no spin on near-full boards), picks one via the injected rng/factory,
 * and returns null when the grid is full.
 */
export function placeFood(state) {
  const factory = state.foodFactory || randomFood;
  return factory(state);
}

/** Create the initial game state. */
export function createGame(options = {}) {
  const width = Number.isInteger(options.width) ? options.width : GRID_WIDTH;
  const height = Number.isInteger(options.height) ? options.height : GRID_HEIGHT;
  if (width < 3 || height < 3) {
    throw new RangeError('Snake grid must be at least 3x3');
  }
  const length = Number.isInteger(options.length)
    ? Math.min(Math.max(options.length, 1), Math.min(width, height))
    : INITIAL_LENGTH;

  const rng = typeof options.rng === 'function' ? options.rng : createRng(options.seed);
  const foodFactory =
    typeof options.placeFood === 'function' ? options.placeFood : randomFood;

  const headX = Math.floor(width / 2);
  const headY = Math.floor(height / 2);
  const snake = [];
  for (let i = 0; i < length; i += 1) {
    snake.push(key(headX - i, headY));
  }

  const base = {
    width,
    height,
    snake,
    direction: 'right',
    pending: null,
    food: null,
    score: 0,
    ticks: 0,
    status: 'ready',
    outcome: null,
    rng,
    foodFactory,
    options: { ...options, width, height, length },
  };

  return { ...base, food: placeFood(base) };
}

export function isOver(state) {
  return state.status === 'over';
}

/**
 * Queue a direction change. Compared against `pending ?? direction` for
 * duplicates and against the actual travelling `direction` for the 180 rule,
 * so a second keypress inside one tick cannot reverse the snake into itself.
 * Returns the state unchanged on rejection.
 */
export function queueDirection(state, direction) {
  if (state.status === 'over' || !isDirection(direction)) return state;
  const current = state.pending ?? state.direction;
  if (direction === current) return state;
  if (isOpposite(current, direction)) return state;
  return { ...state, pending: direction };
}

export function start(state) {
  if (state.status === 'over') return state;
  if (state.status === 'running') return state;
  return { ...state, status: 'running' };
}

export function pause(state) {
  if (state.status !== 'running') return state;
  return { ...state, status: 'paused' };
}

export function resume(state) {
  if (state.status === 'over' || state.status !== 'paused') return state;
  return { ...state, status: 'running' };
}

/** Rebuild a fresh game from the stored options, already running. */
export function restart(state) {
  return start(createGame(state.options));
}

/**
 * Advance the game by exactly one tick. No-op unless running.
 * Moving into the cell the tail just vacated is legal.
 */
export function step(state) {
  if (state.status !== 'running') return state;

  const direction = state.pending ?? state.direction;
  const { dx, dy } = DIRECTIONS[direction];

  const body = state.snake.slice(0, -1);
  const headKey = state.snake[0];
  const [hx, hy] = [parseKey(headKey).x, parseKey(headKey).y];
  const nx = hx + dx;
  const ny = hy + dy;

  if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) {
    return { ...state, direction, pending: null, status: 'over', outcome: 'wall' };
  }

  const nextHead = key(nx, ny);
  const ate = state.food !== null && nextHead === state.food;

  // The tail cell is vacated this tick unless we grow.
  const occupied = ate ? state.snake : body;
  if (occupied.includes(nextHead)) {
    return { ...state, direction, pending: null, status: 'over', outcome: 'self' };
  }

  const snake = [nextHead, ...occupied];
  const ticks = state.ticks + 1;

  if (!ate) {
    return { ...state, snake, direction, pending: null, ticks };
  }

  const score = state.score + 1;
  const next = { ...state, snake, direction, pending: null, ticks, score };
  const food = placeFood(next);
  if (food === null) {
    return { ...next, food: null, status: 'over', outcome: 'win' };
  }
  return { ...next, food };
}

/** Advance up to `count` ticks, stopping early on game over. */
export function run(state, count) {
  let current = state;
  for (let i = 0; i < count; i += 1) {
    const next = step(current);
    if (next === current) break;
    current = next;
    if (current.status === 'over') break;
  }
  return current;
}
