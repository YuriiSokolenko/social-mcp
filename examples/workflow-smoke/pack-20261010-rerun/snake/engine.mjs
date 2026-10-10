/**
 * Pure Snake rules for the pack-20261010-rerun smoke example.
 *
 * No DOM, timers, randomness globals, network, or filesystem access: the
 * state is a plain immutable object and every mutator returns a new object
 * (or the same reference when the action is a no-op).
 */

export const GRID_WIDTH = 20;
export const GRID_HEIGHT = 20;
export const INITIAL_LENGTH = 3;
export const INITIAL_SCORE = 0;
export const INITIAL_TICKS = 0;

export const DIRECTIONS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

export const OPPOSITE_DIRECTIONS = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
}

export const INITIAL_DIRECTION = "right";

const INITIAL_SEED = 0x2f6e2b1;

export function key(x, y) {
  return `${x},${y}`;
}

export function parseKey(cellKey) {
  const [x, y] = String(cellKey).split(",").map(Number);
  return { x, y };
}

/** Small deterministic PRNG (mulberry32). Returns () => [0, 1). */
export function createRng(seed = INITIAL_SEED) {
  let state = (Math.trunc(Number(seed) || 0) >>> 0) || 0x9e3779b9;
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

export function createGame(options = {}) {
  const {
    width = GRID_WIDTH,
    height = GRID_HEIGHT,
    seed = INITIAL_SEED,
    direction = INITIAL_DIRECTION,
  } = options;

  if (!Number.isInteger(width) || width < 3) {
    throw new RangeError("width must be an integer >= 3");
  }
  if (!Number.isInteger(height) || height < 3) {
    throw new RangeError("height must be an integer >= 3");
  }
  if (!DIRECTIONS[direction]) {
    throw new RangeError(`unknown direction: ${direction}`);
  }

  const startY = Math.floor(height / 2);
  const startX = Math.max(0, Math.floor(width / 2) - Math.floor(INITIAL_LENGTH / 2));

  // Head first.
  const snake = [];
  for (let i = 0; i < INITIAL_LENGTH; i += 1) {
    snake.push(key(startX + (INITIAL_LENGTH - 1 - i), startY));
  }

  const state = {
    options: { width, height, seed, direction },
    width,
    height,
    snake,
    direction,
    pending: null,
    food: null,
    score: INITIAL_SCORE,
    ticks: INITIAL_TICKS,
    status: "ready",
    outcome: null,
  };

  const food = placeFood(state, options);
  return { ...state, food };
}

/**
 * Deterministic, bounded food placement over the free cells.
 * Returns the chosen cell key, or null when the grid is full.
 */
export function placeFood(state, options = {}) {
  const seed = options.seed ?? state.options?.seed ?? INITIAL_SEED;
  const { rng = createRng(seed) } = options;
  const occupied = new Set(state.snake);
  const free = [];

  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      const cell = key(x, y);
      if (!occupied.has(cell)) {
        free.push(cell);
      }
    }
  }

  if (free.length === 0) {
    return null;
  }

  const index = Math.min(free.length - 1, Math.floor(rng() * free.length));
  return free[index];
}

function canTurn(state, direction) {
  if (!DIRECTIONS[direction]) {
    return false;
  }
  const queued = state.pending ?? state.direction;
  if (direction === queued) {
    return false;
  }
  if (OPPOSITE_DIRECTIONS[state.direction] === direction) {
    return false;
  }
  return OPPOSITE_DIRECTIONS[queued] !== direction;
}

export function isOver(state) {
  return state.status === "over";
}

/**
 * Queue the next heading. The 180 degree check runs against the *current*
 * heading so a second keypress inside the same tick cannot reverse the snake.
 */
export function queueDirection(state, direction) {
  if (state.status !== "running" && state.status !== "ready") {
    return state;
  }
  if (!canTurn(state, direction)) {
    return state;
  }
  return { ...state, pending: direction };
}

export function start(state) {
  if (state.status !== "ready") {
    return state;
  }
  return { ...state, status: "running" };
}

export function pause(state) {
  if (state.status !== "running") {
    return state;
  }
  return { ...state, status: "paused" };
}

export function resume(state) {
  if (state.status !== "paused") {
    return state;
  }
  return { ...state, status: "running" };
}

export function restart(state) {
  return start(createGame({ ...state.options }));
}

/** Advance exactly one tick, or return the same state when not running. */
export function step(state) {
  if (state.status !== "running") {
    return state;
  }

  const direction = state.pending ?? state.direction;
  const delta = DIRECTIONS[direction];
  const head = parseKey(state.snake[0]);
  const nextHead = key(head.x + delta.x, head.y + delta.y);

  if (
    head.x + delta.x < 0 ||
    head.x + delta.x >= state.width ||
    head.y + delta.y < 0 ||
    head.y + delta.y >= state.height
  ) {
    return { ...state, direction, pending: null, status: "over", outcome: "wall" };
  }

  const eating = state.food !== null && state.food === nextHead;
  const body = eating ? state.snake : state.snake.slice(0, -1);
  if (body.includes(nextHead)) {
    return { ...state, direction, pending: null, status: "over", outcome: "self" };
  }

  const snake = [nextHead, ...body];
  const next = {
    ...state,
    direction,
    pending: null,
    snake,
    ticks: state.ticks + 1,
  };

  if (!eating) {
    return next;
  }

  const food = placeFood(next, { seed: state.options.seed });
  if (food === null) {
    return { ...next, food: null, score: state.score + 1, status: "over", outcome: "win" };
  }
  return { ...next, food, score: state.score + 1 };
}

/** Advance up to `ticks` steps, stopping early on game over. */
export function run(state, ticks = 1) {
  const count = Math.max(0, Math.trunc(Number(ticks) || 0));
  let current = state;
  for (let i = 0; i < count; i += 1) {
    const next = step(current);
    if (next === current) {
      break;
    }
    current = next;
    if (isOver(current)) {
      break;
    }
  }
  return current;
}

/** Convenience for the renderer: "ArrowUp"/"w" -> engine direction. */
export function parseKeyInput(input) {
  if (typeof input !== "string") {
    return null;
  }
  const normalized = input.trim().toLowerCase();
  const map = {
    arrowup: "up",
    arrowdown: "down",
    arrowleft: "left",
    arrowright: "right",
    w: "up",
    s: "down",
    a: "left",
    d: "right",
  };
  return map[normalized] ?? null;
}