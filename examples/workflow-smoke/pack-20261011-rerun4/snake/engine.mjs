// Pure, deterministic Snake game rules.
//
// No DOM, no timers, no network, no Math.random: every transition is a pure
// function of the supplied state (and an injectable RNG), so the rules are
// fully testable with `node --test`.

export const GRID_WIDTH = 21;
export const GRID_HEIGHT = 21;
export const INITIAL_LENGTH = 3;
export const MIN_GRID_SIZE = 3;
export const MAX_PENDING_TURNS = 2;

export const STATUS_READY = 'ready';
export const STATUS_RUNNING = 'running';
export const STATUS_PAUSED = 'paused';
export const STATUS_OVER = 'over';

export const OUTCOME_WALL = 'wall';
export const OUTCOME_SELF = 'self';
export const OUTCOME_WIN = 'win';

export const DIRECTIONS = Object.freeze({
  up: Object.freeze({ dx: 0, dy: -1 }),
  down: Object.freeze({ dx: 0, dy: 1 }),
  left: Object.freeze({ dx: -1, dy: 0 }),
  right: Object.freeze({ dx: 1, dy: 0 }),
});

/** Keyboard key (lower-cased) -> canonical direction name. */
export const KEY_DIRECTIONS = Object.freeze({
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
});

export function key(x, y) {
  return `${x},${y}`;
}

export function parseKey(cellKey) {
  const [x, y] = String(cellKey).split(',');
  return { x: Number(x), y: Number(y) };
}

function normalizeDirection(dir) {
  if (dir === null || dir === undefined) return null;
  if (typeof dir === 'string') {
    const name = dir.toLowerCase();
    return Object.hasOwn(DIRECTIONS, name) ? name : null;
  }
  if (typeof dir === 'object' && 'dx' in dir && 'dy' in dir) {
    for (const [name, vec] of Object.entries(DIRECTIONS)) {
      if (vec.dx === dir.dx && vec.dy === dir.dy) return name;
    }
  }
  return null;
}

/** Direction vector ({dx,dy}) for a canonical name, or null. */
export function directionVector(dir) {
  const name = normalizeDirection(dir);
  return name ? DIRECTIONS[name] : null;
}

function isOpposite(a, b) {
  const va = directionVector(a);
  const vb = directionVector(b);
  return !!va && !!vb && va.dx === -vb.dx && va.dy === -vb.dy;
}

/**
 * Deterministic seeded PRNG (mulberry32). Returns () => float in [0, 1).
 * The same seed always yields the same sequence.
 */
export function createRng(seed = 1) {
  const numeric = Number.isFinite(seed) ? Math.trunc(seed) : 1;
  let a = numeric >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** All cells in the grid, row-major, as "x,y" keys. */
export function allCells(width, height) {
  const cells = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) cells.push(key(x, y));
  }
  return cells;
}

/** Free (unoccupied) cells, sorted for deterministic candidate ordering. */
export function freeCells(state) {
  const taken = new Set(state.snake);
  const free = [];
  for (const cell of allCells(state.width, state.height)) {
    if (!taken.has(cell)) free.push(cell);
  }
  return free.sort();
}

/**
 * Pick a food cell not occupied by the snake.
 * Returns a "x,y" key, or null when the grid is full.
 */
export function placeFood(state, rng = createRng(state.seed)) {
  const free = freeCells(state);
  if (free.length === 0) return null;
  const index = Math.floor(rng() * free.length) % free.length;
  return free[index];
}

function spawnSnake(width, height, length) {
  const y = Math.floor(height / 2);
  const headX = Math.floor(width / 2);
  const cells = [];
  for (let i = 0; i < length; i += 1) cells.push(key(headX - i, y));
  return cells;
}

/**
 * Create a fresh game in the `ready` status.
 * Food placement is injectable via `placeFoodFn` for deterministic tests.
 */
export function createGame(options = {}) {
  const {
    width = GRID_WIDTH,
    height = GRID_HEIGHT,
    seed = 1,
    rng = createRng(seed),
    placeFoodFn = null,
    length = INITIAL_LENGTH,
    snake = null,
    direction = 'right',
  } = options;

  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new RangeError('width and height must be integers');
  }
  if (width < MIN_GRID_SIZE || height < MIN_GRID_SIZE) {
    throw new RangeError(`grid must be at least ${MIN_GRID_SIZE}x${MIN_GRID_SIZE}`);
  }

  const body = Array.isArray(snake) && snake.length > 0
    ? snake.slice()
    : spawnSnake(width, height, Math.max(1, Math.min(length, width * height)));

  const place = placeFoodFn ? (s) => placeFoodFn(s) : (s) => placeFood(s, rng);

  const state = {
    width,
    height,
    seed,
    snake: body,
    direction: normalizeDirection(direction) ?? 'right',
    pending: [],
    food: null,
    score: 0,
    ticks: 0,
    status: STATUS_READY,
    outcome: null,
    placeFoodFn: place,
  };

  const food = place(state);
  return { ...state, food: food === undefined ? null : food };
}

export function isFinished(state) {
  return state.status === STATUS_OVER;
}

export function isPlaying(state) {
  return state.status === STATUS_RUNNING;
}

/** Start a ready game. */
export function start(state) {
  if (isFinished(state) || state.status === STATUS_RUNNING) return state;
  return { ...state, status: STATUS_RUNNING };
}

/** Resume a paused (or ready) game. */
export function resume(state) {
  return start(state);
}

/** Pause a running game; queued turns are preserved. */
export function pause(state) {
  if (isFinished(state) || state.status === STATUS_PAUSED) return state;
  return { ...state, status: STATUS_PAUSED };
}

/** Toggle between running and paused. */
export function togglePause(state) {
  return state.status === STATUS_RUNNING ? pause(state) : resume(state);
}

/** Restart with the same configuration: fresh board, back to `ready`. */
export function restart(state, options = {}) {
  return createGame({
    width: state.width,
    height: state.height,
    seed: state.seed,
    placeFoodFn: state.placeFoodFn,
    ...options,
  });
}

/**
 * Queue a direction change without mutating. At most MAX_PENDING_TURNS turns
 * are buffered; the immediate 180° reversal relative to the direction that
 * will be in effect at the next tick is ignored, as are null/unknown values.
 */
export function queueDirection(state, dir) {
  const name = normalizeDirection(dir);
  if (!name) return state;
  if (isFinished(state)) return state;
  if (state.pending.length >= MAX_PENDING_TURNS) return state;

  const last = state.pending.length > 0
    ? state.pending[state.pending.length - 1]
    : state.direction;
  if (isOpposite(name, last)) return state;
  if (name === last) return state;

  return { ...state, pending: [...state.pending, name] };
}

function gameOver(state, outcome, snake) {
  return {
    ...state,
    snake,
    status: STATUS_OVER,
    outcome,
    pending: [],
  };
}

/**
 * Advance the game by exactly one tick. Returns a NEW state object; the
 * input state is never mutated. A finished game returns itself unchanged.
 */
export function step(state) {
  if (state.status !== STATUS_RUNNING) return state;

  const pending = state.pending.slice();
  const direction = pending.length > 0 ? pending.shift() : state.direction;

  const vec = directionVector(direction);
  const head = parseKey(state.snake[0]);
  const nextHead = key(head.x + vec.dx, head.y + vec.dy);

  if (
    head.x + vec.dx < 0 ||
    head.x + vec.dx >= state.width ||
    head.y + vec.dy < 0 ||
    head.y + vec.dy >= state.height
  ) {
    return gameOver(state, OUTCOME_WALL, state.snake.slice());
  }

  const eats = state.food !== null && nextHead === state.food;

  // The tail cell vacates this tick unless we grow, so moving into it is safe.
  const body = eats ? state.snake.slice() : state.snake.slice(0, -1);
  if (body.includes(nextHead)) {
    return gameOver(state, OUTCOME_SELF, state.snake.slice());
  }

  const snake = [nextHead, ...body];
  const base = {
    ...state,
    snake,
    direction,
    pending,
    ticks: state.ticks + 1,
  };

  if (!eats) {
    return { ...base, food: state.food };
  }

  const score = state.score + 1;
  const food = base.placeFoodFn({ ...base, score });

  if (food === undefined || food === null) {
    return { ...base, score, food: null, status: STATUS_OVER, outcome: OUTCOME_WIN };
  }

  return { ...base, score, food };
}

/** Apply `step` exactly `ticks` times, stopping early on game over. */
export function run(state, ticks = 1) {
  let current = state;
  for (let i = 0; i < ticks; i += 1) {
    const next = step(current);
    if (next === current) break;
    current = next;
  }
  return current;
}
