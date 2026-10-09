// Pure, deterministic Snake engine. No DOM, timers, or network: every
// function is synchronous and every random choice comes from an injected
// generator, so a seed reproduces a run and `node --test` can assert it.
//
// State shape (plain object, immutable by convention):
//   width, height  grid dimensions in cells
//   snake          cell keys, head first
//   direction      {dx, dy} applied by the next step
//   pending        queued {dx, dy} or null
//   food           cell key, or null when the grid is full
//   score          food eaten
//   ticks          completed steps
//   status         'ready' | 'running' | 'paused' | 'over'
//   outcome        null | 'win' | 'wall' | 'self'

export const DIRECTIONS = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

export const GRID_WIDTH = 21;
export const GRID_HEIGHT = 21;
export const INITIAL_LENGTH = 3;

export function key(x, y) {
  return `${x},${y}`;
}

export function parseKey(cell) {
  const [x, y] = cell.split(',');
  return { x: Number(x), y: Number(y) };
}

/** Seedable xorshift32 generator so runs are reproducible. */
export function createRng(seed = 1) {
  let state = (seed >>> 0) || 1;
  return function rng() {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

/**
 * Choose uniformly among free cells, or return null when the snake occupies
 * the whole grid. Candidates are built once from the grid, so placement is
 * bounded and can never spin on a nearly full board.
 */
export function placeFood(state) {
  const occupied = new Set(state.snake);
  const free = [];
  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      const cell = key(x, y);
      if (!occupied.has(cell)) free.push(cell);
    }
  }
  if (free.length === 0) return null;
  return free[Math.floor(state.rng() * free.length)];
}

/**
 * Build the initial state. `rng` and `placeFood` are injectable so tests get
 * deterministic food placement that never lands on the snake.
 */
export function createGame(options = {}) {
  const width = options.width ?? GRID_WIDTH;
  const height = options.height ?? GRID_HEIGHT;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3) {
    throw new RangeError('grid must be at least 3x3');
  }
  const startX = Math.floor(width / 2);
  const startY = Math.floor(height / 2);
  const snake = [];
  for (let i = 0; i < INITIAL_LENGTH; i += 1) snake.push(key(startX - i, startY));

  const game = {
    width,
    height,
    snake,
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
  // Place the first food through the same bounded, injectable strategy.
  const placed = game.foodFactory(game);
  return { ...game, food: placed ?? null };
}

export function isOver(state) {
  return state.status === 'over';
}

/**
 * Queue a direction for the next step. The 180 degree rule is checked against
 * the direction the snake is actually travelling, so a second keypress inside
 * the same tick cannot reverse the snake into its own body.
 */
export function queueDirection(state, next) {
  if (state.status === 'over') return state;
  const direction = typeof next === 'string' ? DIRECTIONS[next] : next;
  if (!direction || typeof direction.dx !== 'number' || typeof direction.dy !== 'number') {
    return state;
  }
  const current = state.pending ?? state.direction;
  if (direction.dx === current.dx && direction.dy === current.dy) return state;
  if (direction.dx === -state.direction.dx && direction.dy === -state.direction.dy) {
    return state;
  }
  return { ...state, pending: { dx: direction.dx, dy: direction.dy } };
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

/** Fresh game with the same grid and injection points, already running. */
export function restart(state) {
  const options = state?.options ?? {};
  return start(createGame(options));
}

/**
 * Advance exactly one cell. Returns the state untouched unless it is running,
 * so a paused or finished game cannot be stepped by accident.
 */
export function step(state) {
  if (state.status !== 'running') return state;
  const direction = state.pending ? { ...state.pending } : { ...state.direction };
  const head = parseKey(state.snake[0]);
  const target = key(head.x + direction.dx, head.y + direction.dy);
  const base = { ...state, direction, pending: null, ticks: state.ticks + 1 };

  const point = parseKey(target);
  if (point.x < 0 || point.x >= state.width || point.y < 0 || point.y >= state.height) {
    return { ...base, status: 'over', outcome: 'wall' };
  }

  const ate = state.food !== null && state.food === target;
  // The tail cell is vacated by this very move, so stepping into it is safe.
  const body = ate ? state.snake : state.snake.slice(0, -1);
  if (body.includes(target)) {
    return { ...base, status: 'over', outcome: 'self' };
  }

  const snake = [target, ...body];
  if (!ate) return { ...base, snake };

  const grew = { ...base, snake, score: state.score + 1 };
  const food = grew.foodFactory(grew);
  // Null food means the snake filled the grid: that is a win, not a loss.
  if (food === null) return { ...grew, food: null, status: 'over', outcome: 'win' };
  return { ...grew, food };
}

/** Advance `count` ticks, stopping as soon as the game ends. */
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
