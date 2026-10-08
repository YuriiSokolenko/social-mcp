/**
 * Pure, deterministic Snake game engine.
 *
 * Everything in this module is plain data in / data out: no DOM, no `window`,
 * no timers, no network, no untethered randomness. That keeps the game rules
 * unit-testable with `node --test` and lets the renderer in `main.mjs` own
 * nothing but presentation.
 */

export const GRID_WIDTH = 20;
export const GRID_HEIGHT = 20;

/** Fixed timestep between two game ticks, independent of display refresh. */
export const TICK_MS = 120;

export const DIRECTIONS = Object.freeze(['up', 'down', 'left', 'right']);

const VECTORS = Object.freeze({
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
});

const OPPOSITES = Object.freeze({
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
});

export const STATUS = Object.freeze({
  READY: 'ready',
  RUNNING: 'running',
  PAUSED: 'paused',
  OVER: 'over',
  WON: 'won',
});

export function isDirection(direction) {
  return Object.prototype.hasOwnProperty.call(VECTORS, direction);
}

export function opposite(direction) {
  return OPPOSITES[direction];
}

/** A direction is the exact 180-degree reversal of `from`. */
export function isReversal(direction, from) {
  return isDirection(direction) && isDirection(from) && direction === OPPOSITES[from];
}

function assertPositiveInt(value, fallback, label) {
  if (!Number.isInteger(value) || value < 2) {
    console.warn(`snake/engine: ignoring invalid ${label}=${JSON.stringify(value)}, using ${fallback}`);
    return fallback;
  }
  return value;
}

function normaliseRandom(random) {
  if (random === undefined || random === null) return Math.random;
  if (typeof random !== 'function') {
    throw new TypeError('snake/engine: random must be a function');
  }
  return random;
}

/**
 * Row-major list of every cell on the board that the snake does not occupy.
 * Bounded by `width * height`, so callers can rely on termination even when
 * the snake fills the grid.
 */
export function findFreeCells(state) {
  const occupied = new Set(state.cells.map((cell) => `${cell.x},${cell.y}`));
  const free = [];
  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      if (!occupied.has(`${x},${y}`)) free.push({ x, y });
    }
  }
  return free;
}

/** Default food strategy: uniform pick over the free cells using `random`. */
export function defaultPlaceFood(context) {
  const { freeCells, random } = context;
  if (freeCells.length === 0) return null;
  const index = Math.floor(random(freeCells.length) * freeCells.length);
  // A misbehaving rng (NaN, out of range) still resolves to a legal cell.
  const safe = Math.min(freeCells.length - 1, Math.max(0, Number.isFinite(index) ? index : 0));
  return freeCells[safe];
}

/**
 * Build a game engine.
 *
 * @param {object} [options]
 * @param {number} [options.width] grid columns
 * @param {number} [options.height] grid rows
 * @param {() => number} [options.random] seeded source in `[0, 1)`; inject a
 *   fake in tests so food placement is reproducible
 * @param {(context: {freeCells: Array<{x:number,y:number}>, random: () => number, state: object}) => {x:number,y:number}|null}
 *   [options.placeFood] fully override food placement (winners take all)
 */
export function createEngine(options = {}) {
  const width = assertPositiveInt(options.width ?? GRID_WIDTH, GRID_WIDTH, 'width');
  const height = assertPositiveInt(options.height ?? GRID_HEIGHT, GRID_HEIGHT, 'height');
  const random = normaliseRandom(options.random);
  const placeFood = options.placeFood ?? defaultPlaceFood;

  function placeFoodCell(state) {
    const cell = placeFood({ freeCells: findFreeCells(state), random, state });
    if (!cell) return null;
    return { x: cell.x, y: cell.y };
  }

  /** A fresh, ready-to-start board with a three-cell snake and one food. */
  function initialState() {
    const midX = Math.floor(width / 2);
    const midY = Math.floor(height / 2);
    const cells = [
      { x: midX, y: midY },
      { x: midX - 1, y: midY },
      { x: midX - 2, y: midY },
    ];
    const base = {
      width,
      height,
      cells,
      direction: 'right',
      appliedDirection: 'right',
      pending: [],
      score: 0,
      ticks: 0,
      status: STATUS.READY,
      // `pausedFrom` records which status to resume into.
      pausedFrom: null,
      food: null,
    };
    return { ...base, food: placeFoodCell(base) };
  }

  /** Move into `start`; queued directions are kept for the caller's benefit. */
  function start(state) {
    if (state.status === STATUS.READY) return { ...state, status: STATUS.RUNNING };
    return state;
  }

  /**
   * Queue the next travel direction.
   *
   * Queued directions are validated against the last queued (or last applied)
   * direction, so even two key presses inside a single tick can never produce
   * a 180-degree reversal. Unknown, repeated and reversing directions are
   * silently ignored rather than throwing.
   */
  function setDirection(state, direction) {
    if (!isDirection(direction) || state.status === STATUS.OVER || state.status === STATUS.WON) {
      return state;
    }
    const pending = state.pending.slice();
    const last = pending.length > 0 ? pending[pending.length - 1] : state.appliedDirection;
    if (direction === last || isReversal(direction, last)) return state;
    pending.push(direction);
    return { ...state, direction, pending: pending.slice(0, 2) };
  }

  function pause(state) {
    if (state.status !== STATUS.RUNNING) return state;
    return { ...state, status: STATUS.PAUSED, pausedFrom: STATUS.RUNNING };
  }

  function resume(state) {
    if (state.status !== STATUS.PAUSED) return state;
    return { ...state, status: STATUS.RUNNING, pausedFrom: null };
  }

  function togglePause(state) {
    if (state.status === STATUS.RUNNING) return pause(state);
    if (state.status === STATUS.PAUSED) return resume(state);
    return state;
  }

  /** Abandon this game and return a brand-new ready board. */
  function restart() {
    return initialState();
  }

  /** One fixed-timestep step. No-ops unless the game is running. */
  function tick(state) {
    if (state.status !== STATUS.RUNNING) return state;

    const pending = state.pending.length > 0 ? state.pending : [state.appliedDirection];
    const direction = pending[0];
    const vector = VECTORS[direction];
    const head = state.cells[0];
    const next = { x: head.x + vector.x, y: head.y + vector.y };

    const hitWall = next.x < 0 || next.x >= state.width || next.y < 0 || next.y >= state.height;
    if (hitWall) {
      return { ...state, status: STATUS.OVER, pending: [], direction, pausedFrom: null };
    }

    const body = state.cells;
    const ate = state.food !== null && state.food.x === next.x && state.food.y === next.y;
    // The tail cell vacates on a non-growing move, so it is not an obstacle.
    const kept = ate ? body : body.slice(0, -1);
    const hitSelf = kept.some((cell) => cell.x === next.x && cell.y === next.y);
    if (hitSelf) {
      return { ...state, status: STATUS.OVER, pending: [], direction, pausedFrom: null };
    }

    const cells = [next, ...kept];
    const score = ate ? state.score + 1 : state.score;
    const advanced = {
      ...state,
      cells,
      score,
      direction,
      appliedDirection: direction,
      pending: pending.slice(1),
      ticks: state.ticks + 1,
    };

    if (!ate) return { ...advanced, food: state.food };

    const food = placeFoodCell(advanced);
    const won = food === null;
    return {
      ...advanced,
      food,
      status: won ? STATUS.WON : STATUS.RUNNING,
    };
  }

  return {
    width,
    height,
    initialState,
    start,
    setDirection,
    pause,
    resume,
    togglePause,
    restart,
    tick,
    findFreeCells,
  };
}
