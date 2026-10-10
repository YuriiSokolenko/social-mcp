// Pure, deterministic Arkanoid / Breakout rules engine for issue #755.
//
// This module owns all game rules and physics; it never touches the DOM,
// Canvas, timers, Math.random, or network so Node can unit-test it directly.
//
// State shape (plain data, copy-on-write):
//   width, height                       logical arena size in pixels
//   dt                                  fixed timestep in seconds
//   ball  { x, y, vx, vy, radius, attached }  centre point, velocity px/s
//   paddle{ x, y, width, height, speed }      x is the paddle centre
//   bricks[{ id, x, y, width, height, hits, points, alive }]  top-left rects
//   score, lives, level, bricksLeft, steps
//   status  'ready' | 'running' | 'paused' | 'over'
//   outcome null    | 'win'    | 'lose'
//   rng, layoutFactory, options         deterministic rebuild data
//
// Every function returns a NEW object, never mutates its input, and returns
// the identical reference for an illegal transition (asserted by the tests).

export const WIDTH = 640;
export const HEIGHT = 480;

/** Seconds advanced per physics substep; the browser loop calls `step` a fixed number of times per frame. */
export const DT = 1 / 120;

export const BALL_RADIUS = 7;
export const BALL_SPEED = 360;
export const MAX_BALL_SPEED = 520;
/** Smallest |vy| after a resolution, so the ball can never loop forever horizontally. */
export const MIN_VERTICAL_SPEED = 60;

export const PADDLE_WIDTH = 96;
export const PADDLE_HEIGHT = 14;
export const PADDLE_SPEED = 460;
/** Paddle hits leave the surface at most this far from the vertical axis. */
export const MAX_BOUNCE_ANGLE = Math.PI / 3;

export const INITIAL_LIVES = 3;
export const BRICK_ROWS = 5;
export const BRICK_COLS = 8;
export const BRICK_POINTS = 7;
export const BRICK_TOP = 60;
export const BRICK_BOTTOM = 180;
export const BRICK_SIDEBAND = 20;
export const BRICK_GAP = 4;

/** Deterministic 32-bit xorshift generator, so a seed reproduces a layout and a serve angle. */
export function createRng(seed = 1) {
  const value = Number.isFinite(seed) ? seed : 1;
  let state = Math.trunc(value) >>> 0;
  if (state === 0) {
    state = 0x9e3779b9;
  }
  return function next() {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function toFiniteNumber(value, name, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new RangeError(`${name} must be a finite number`);
  }
  return number;
}

function toInteger(value, name, fallback) {
  return Math.trunc(toFiniteNumber(value, name, fallback));
}

function normalizeRng(options) {
  if (options.rng && typeof options.rng.next === "function") {
    const rng = options.rng;
    return function next() {
      const value = Number(rng.next());
      return Number.isFinite(value) ? value : 0;
    };
  }
  if (typeof options.rng === "function") {
    const rng = options.rng;
    return function next() {
      const value = Number(rng());
      return Number.isFinite(value) ? value : 0;
    };
  }
  return createRng(options.seed);
}

/**
 * Builds the default brick wall: a full grid, top rows reinforced (2 hits,
 * worth 2x points). Rows and columns can be reduced for compact tests.
 */
export function createBricks(options = {}) {
  const width = toFiniteNumber(options.width, "width", WIDTH);
  const height = toFiniteNumber(options.height, "height", HEIGHT);
  const rows = Math.max(1, toInteger(options.rows, "rows", BRICK_ROWS));
  const cols = Math.max(1, toInteger(options.cols, "cols", BRICK_COLS));
  const top = toFiniteNumber(options.top, "top", BRICK_TOP);
  const bottom = toFiniteNumber(
    options.bottom,
    "bottom",
    Math.min(BRICK_BOTTOM, height / 2),
  );
  const sideband = toFiniteNumber(options.sideband, "sideband", BRICK_SIDEBAND);
  const gap = toFiniteNumber(options.gap, "gap", BRICK_GAP);
  const points = toInteger(options.points, "points", BRICK_POINTS);

  if (width <= 0 || height <= 0) {
    throw new RangeError("createBricks requires a positive arena");
  }
  if (bottom <= top) {
    throw new RangeError("createBricks requires bottom > top");
  }
  if (sideband < 0 || gap < 0) {
    throw new RangeError("createBricks requires non-negative sideband and gap");
  }
  const usableWidth = width - 2 * sideband - gap * (cols - 1);
  const usableHeight = bottom - top - gap * (rows - 1);
  if (usableWidth <= 0 || usableHeight <= 0) {
    throw new RangeError("createBricks leaves no room for the brick grid");
  }

  const brickWidth = usableWidth / cols;
  const brickHeight = usableHeight / rows;
  const bricks = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const reinforced = row < Math.max(1, Math.floor(rows / 5));
      bricks.push({
        id: bricks.length,
        x: sideband + col * (brickWidth + gap),
        y: top + row * (brickHeight + gap),
        width: brickWidth,
        height: brickHeight,
        hits: reinforced ? 2 : 1,
        points: reinforced ? points * 2 : points,
        alive: true,
      });
    }
  }
  return bricks;
}

function normalizeBricks(input) {
  if (input === undefined || input === null) {
    return null;
  }
  if (!Array.isArray(input)) {
    throw new TypeError("bricks must be an array of brick rectangles");
  }
  return input.map((brick, index) => {
    const width = toFiniteNumber(brick.width, "brick.width", 0);
    const height = toFiniteNumber(brick.height, "brick.height", 0);
    if (width <= 0 || height <= 0) {
      throw new RangeError(`bricks[${index}] requires positive width and height`);
    }
    return {
      id: toInteger(brick.id, "brick.id", index),
      x: toFiniteNumber(brick.x, "brick.x", 0),
      y: toFiniteNumber(brick.y, "brick.y", 0),
      width,
      height,
      hits: Math.max(1, toInteger(brick.hits, "brick.hits", 1)),
      points: toInteger(brick.points, "brick.points", BRICK_POINTS),
      alive: brick.alive === undefined ? true : Boolean(brick.alive),
    };
  });
}

function createPaddle(options, width, height) {
  const pw = toFiniteNumber(options.width, "paddle.width", PADDLE_WIDTH);
  const ph = toFiniteNumber(options.height, "paddle.height", PADDLE_HEIGHT);
  const speed = toFiniteNumber(options.speed, "paddle.speed", PADDLE_SPEED);
  if (pw <= 0 || pw > width) {
    throw new RangeError("paddle must fit inside the arena width");
  }
  if (ph <= 0 || ph > height) {
    throw new RangeError("paddle must fit inside the arena height");
  }
  if (speed <= 0) {
    throw new RangeError("paddle.speed must be positive");
  }
  const defaults = {
    x: width / 2,
    y: height - PADDLE_HEIGHT * 2 - 4,
  };
  return {
    x: Math.min(Math.max(toFiniteNumber(options.x, "paddle.x", defaults.x), pw / 2), width - pw / 2),
    y: toFiniteNumber(options.y, "paddle.y", defaults.y),
    width: pw,
    height: ph,
    speed,
  };
}

function createBall(options, paddle, radius) {
  const ballSpeed = toFiniteNumber(options.ballSpeed, "ballSpeed", BALL_SPEED);
  if (ballSpeed <= 0) {
    throw new RangeError("ballSpeed must be positive");
  }
  return {
    x: toFiniteNumber(options.x, "ball.x", paddle.x),
    y: toFiniteNumber(options.y, "ball.y", paddle.y - radius - paddle.height / 2 - 1),
    vx: toFiniteNumber(options.vx, "ball.vx", 0),
    vy: toFiniteNumber(options.vy, "ball.vy", 0),
    radius,
    attached: options.attached === undefined ? true : Boolean(options.attached),
  };
}

/** Number of live bricks left in a wall; used for the win condition. */
export function countBricks(bricks) {
  if (!Array.isArray(bricks)) {
    throw new TypeError("bricks must be an array of brick rectangles");
  }
  return bricks.reduce((total, brick) => total + (brick.alive === false ? 0 : 1), 0);
}

export function createGame(options = {}) {
  const width = toFiniteNumber(options.width, "width", WIDTH);
  const height = toFiniteNumber(options.height, "height", HEIGHT);
  if (width <= 0 || height <= 0) {
    throw new RangeError("createGame requires a positive arena");
  }
  const radius = toFiniteNumber(options.ballRadius, "ballRadius", BALL_RADIUS);
  if (radius <= 0 || radius * 2 > Math.min(width, height)) {
    throw new RangeError("ballRadius must fit inside the arena");
  }
  const paddle = createPaddle(options.paddle ?? {}, width, height);
  const layoutFactory =
    typeof options.layoutFactory === "function"
      ? options.layoutFactory
      : createBricks;
  const bricks =
    options.bricks !== undefined && options.bricks !== null
      ? normalizeBricks(options.bricks)
      : normalizeBricks(
          layoutFactory({
            width,
            height,
            rows: options.rows,
            cols: options.cols,
            top: options.top,
            bottom: options.bottom,
            sideband: options.sideband,
            gap: options.gap,
            points: options.points,
            seed: options.seed,
          }),
        );
  if (!bricks || bricks.length === 0) {
    throw new RangeError("createGame requires at least one brick");
  }
  const ball = createBall(options, paddle, radius);
  const lives = Math.max(1, toInteger(options.lives, "lives", INITIAL_LIVES));

  return {
    width,
    height,
    dt: DT,
    ball,
    paddle,
    bricks,
    score: toInteger(options.score, "score", 0),
    lives,
    level: Math.max(1, toInteger(options.level, "level", 1)),
    bricksLeft: countBricks(bricks),
    steps: 0,
    status: "ready",
    outcome: null,
    ballSpeed: toFiniteNumber(options.ballSpeed, "ballSpeed", BALL_SPEED),
    maxBallSpeed: Math.max(BALL_SPEED, toFiniteNumber(options.maxBallSpeed, "maxBallSpeed", MAX_BALL_SPEED)),
    rng: normalizeRng(options),
    layoutFactory,
    options: { ...options, width, height },
  };
}

export function isState(state) {
  return Boolean(
    state &&
      typeof state === "object" &&
      state.ball &&
      state.paddle &&
      Array.isArray(state.bricks),
  );
}

export function isOver(state) {
  return isState(state) && state.status === "over";
}

/** Leaves `ready` and serves the ball from the paddle centre. */
export function start(state) {
  if (!isState(state) || state.status !== "ready") {
    return state;
  }
  return launch(state);
}

export function launch(state) {
  if (!isState(state) || !state.ball.attached) {
    return state;
  }
  if (state.status !== "ready" && state.status !== "running") {
    return state;
  }
  const angle = (state.rng() - 0.5) * (Math.PI / 3);
  return {
    ...state,
    status: "running",
    ball: {
      ...state.ball,
      vx: state.ballSpeed * Math.sin(angle),
      vy: -state.ballSpeed * Math.cos(angle),
      attached: false,
    },
  };
}

export function pause(state) {
  if (!isState(state) || state.status !== "running") {
    return state;
  }
  // A ball parked on the paddle has not been served, so pausing before launch
  // would freeze the game in a state the browser loop cannot sensibly resume
  // from. Treat pausing an unlaunched ball as the missed serve (life loss).
  if (state.ball.attached) {
    return loseLife(state);
  }
  return { ...state, status: "paused" };
}

export function resume(state) {
  if (!isState(state) || state.status !== "paused") {
    return state;
  }
  return { ...state, status: "running" };
}

/** Rebuilds the arena from the original options; the new game is running. */
export function restart(state) {
  if (!isState(state)) {
    return state;
  }
  return start(createGame(state.options));
}

function clampPaddle(paddle, state) {
  const half = paddle.width / 2;
  const x = Math.min(Math.max(paddle.x, half), state.width - half);
  if (x === paddle.x) {
    return paddle;
  }
  return { ...paddle, x };
}

/** Pointer/touch control: move the paddle centre towards an absolute x. */
export function movePaddle(state, targetX) {
  if (!isState(state)) {
    return state;
  }
  const x = toFiniteNumber(targetX, "targetX", state.paddle.x);
  const paddle = clampPaddle({ ...state.paddle, x }, state);
  if (paddle === state.paddle) {
    return state;
  }
  const next = { ...state, paddle };
  return next.ball.attached
    ? { ...next, ball: { ...next.ball, x: paddle.x } }
    : next;
}

/** Keyboard/touch control: `steerPaddle(state, "left" | "right")` or `{ dx }`. */
export function steerPaddle(state, direction) {
  if (!isState(state)) {
    return state;
  }
  let dx = 0;
  if (typeof direction === "string") {
    if (direction === "left") {
      dx = -state.paddle.speed * state.dt;
    } else if (direction === "right") {
      dx = state.paddle.speed * state.dt;
    } else {
      return state;
    }
  } else if (direction && typeof direction === "object") {
    dx = toFiniteNumber(direction.dx, "dx", 0);
  } else {
    throw new TypeError("steerPaddle requires a direction string or { dx }");
  }
  return movePaddle(state, state.paddle.x + dx);
}

function clampSpeed(ball, state) {
  const magnitude = Math.hypot(ball.vx, ball.vy);
  if (magnitude === 0) {
    return { ...ball, vx: 0, vy: -state.ballSpeed };
  }
  const limit = Math.min(state.ballSpeed, state.maxBallSpeed);
  if (magnitude <= limit) {
    return ball;
  }
  const scale = limit / magnitude;
  return { ...ball, vx: ball.vx * scale, vy: ball.vy * scale };
}

function ensureVertical(ball) {
  if (Math.abs(ball.vy) >= MIN_VERTICAL_SPEED) {
    return ball;
  }
  const vy = Math.abs(ball.vy) + MIN_VERTICAL_SPEED;
  const vx = Math.sqrt(
    Math.max(0, ball.vx * ball.vx + ball.vy * ball.vy - vy * vy),
  );
  return { ...ball, vx: ball.vx < 0 ? -vx : vx, vy: ball.vy <= 0 ? -vy : vy };
}

function hitBrick(state, index, axis) {
  const bricks = state.bricks.slice();
  const brick = bricks[index];
  const remaining = brick.hits - 1;
  const alive = remaining > 0;
  bricks[index] = { ...brick, hits: Math.max(0, remaining), alive };
  const ball = { ...state.ball };
  if (axis === "x") {
    ball.vx = -ball.vx;
  } else {
    ball.vy = -ball.vy;
  }
  const scored = alive ? 0 : brick.points;
  return {
    ...state,
    bricks,
    ball: ensureVertical(clampSpeed(ball, state)),
    score: state.score + scored,
    bricksLeft: alive ? state.bricksLeft : state.bricksLeft - 1,
  };
}

/**
 * Axis-aligned sweep of the circle against every live brick.
 *
 * Penetration is the clearance the ball has already spent travelling along an
 * axis (`distance + radius` on that axis), so the axis of least penetration is
 * the one whose clearance the ball consumed last. That is what makes a corner
 * contact flip exactly one component and eject the ball outside the brick.
 */
function collideBricks(state) {
  const ball = state.ball;
  const vx = ball.vx * state.dt;
  const vy = ball.vy * state.dt;
  if (vx === 0 && vy === 0) {
    return state;
  }
  for (let index = 0; index < state.bricks.length; index += 1) {
    const brick = state.bricks[index];
    if (brick.alive === false) {
      continue;
    }
    const left = ball.x - ball.radius;
    const right = ball.x + ball.radius;
    const top = ball.y - ball.radius;
    const bottom = ball.y + ball.radius;
    if (right <= brick.x || left >= brick.x + brick.width) {
      continue;
    }
    if (bottom <= brick.y || top >= brick.y + brick.height) {
      continue;
    }
    let xPen = Number.POSITIVE_INFINITY;
    if (vx > 0) {
      xPen = brick.x - left;
    } else if (vx < 0) {
      xPen = right - (brick.x + brick.width);
    }
    let yPen = Number.POSITIVE_INFINITY;
    if (vy > 0) {
      yPen = brick.y - top;
    } else if (vy < 0) {
      yPen = bottom - (brick.y + brick.height);
    }
    // At most one brick resolves per substep, which is what prevents
    // double-scoring or double-removing a brick.
    return hitBrick(state, index, xPen <= yPen ? "x" : "y");
  }
  return state;
}

function collideWalls(state) {
  const ball = { ...state.ball };
  let changed = false;
  if (ball.x - ball.radius <= 0) {
    ball.x = ball.radius;
    ball.vx = Math.abs(ball.vx);
    changed = true;
  } else if (ball.x + ball.radius >= state.width) {
    ball.x = state.width - ball.radius;
    ball.vx = -Math.abs(ball.vx);
    changed = true;
  }
  if (ball.y - ball.radius <= 0) {
    ball.y = ball.radius;
    ball.vy = Math.abs(ball.vy);
    changed = true;
  }
  // There is deliberately no bottom wall: falling past it costs a life.
  if (!changed) {
    return state;
  }
  return { ...state, ball: ensureVertical(clampSpeed(ball, state)) };
}

function collidePaddle(state) {
  const { ball, paddle } = state;
  if (ball.vy <= 0) {
    return state;
  }
  const top = paddle.y - paddle.height / 2;
  const bottom = paddle.y + paddle.height / 2;
  if (ball.y + ball.radius <= top || ball.y - ball.radius >= bottom) {
    return state;
  }
  if (ball.x + ball.radius < paddle.x - paddle.width / 2) {
    return state;
  }
  if (ball.x - ball.radius > paddle.x + paddle.width / 2) {
    return state;
  }
  const offset = Math.min(
    Math.max((ball.x - paddle.x) / (paddle.width / 2), -1),
    1,
  );
  const angle = offset * MAX_BOUNCE_ANGLE;
  const speed = Math.hypot(ball.vx, ball.vy) || state.ballSpeed;
  const nextBall = {
    ...ball,
    x: Math.min(Math.max(ball.x, ball.radius), state.width - ball.radius),
    y: top - ball.radius - 0.5,
    vx: speed * Math.sin(angle),
    vy: -speed * Math.cos(angle),
  };
  return { ...state, ball: ensureVertical(clampSpeed(nextBall, state)) };
}

function loseLife(state) {
  const lives = state.lives - 1;
  if (lives <= 0) {
    return {
      ...state,
      lives: 0,
      status: "over",
      outcome: "lose",
      ball: { ...state.ball, attached: true, vx: 0, vy: 0 },
    };
  }
  return {
    ...state,
    lives,
    status: "ready",
    ball: {
      ...state.ball,
      x: state.paddle.x,
      y: state.paddle.y - state.ball.radius - state.paddle.height / 2 - 1,
      vx: 0,
      vy: 0,
      attached: true,
    },
  };
}

function advance(state) {
  if (state.bricksLeft <= 0) {
    return { ...state, status: "over", outcome: "win" };
  }
  const speed = Math.hypot(state.ball.vx, state.ball.vy);
  let smallest = Math.min(state.ball.radius, state.paddle.height / 2);
  for (const brick of state.bricks) {
    if (brick.alive === false) {
      continue;
    }
    smallest = Math.min(smallest, brick.width / 2, brick.height / 2);
  }
  const travel = speed * state.dt;
  // Sub-step so a fast ball cannot tunnel through a brick or the paddle.
  const passes = Math.max(1, Math.min(16, Math.ceil(travel / Math.max(smallest, 1))));
  const ratio = 1 / passes;
  let current = state;
  for (let pass = 0; pass < passes; pass += 1) {
    const moving = {
      ...current,
      ball: {
        ...current.ball,
        x: current.ball.x + current.ball.vx * state.dt * ratio,
        y: current.ball.y + current.ball.vy * state.dt * ratio,
      },
    };
    const brickHit = collideBricks(moving);
    if (brickHit !== moving) {
      current = brickHit;
      if (current.bricksLeft <= 0) {
        return { ...current, status: "over", outcome: "win" };
      }
      continue;
    }
    const wallHit = collideWalls(moving);
    if (wallHit !== moving) {
      current = wallHit;
      continue;
    }
    const paddleHit = collidePaddle(moving);
    if (paddleHit !== moving) {
      current = paddleHit;
      continue;
    }
    current = moving;
    if (current.ball.y - current.ball.radius > current.height) {
      return loseLife(current);
    }
  }
  return { ...current, steps: state.steps + 1 };
}

/** Advances exactly one fixed timestep. Non-running games are returned unchanged. */
export function step(state) {
  if (!isState(state) || state.status !== "running") {
    return state;
  }
  if (state.ball.attached) {
    // A serve must be launched explicitly; treat the drop as a miss.
    return loseLife(state);
  }
  return advance(state);
}

/** Steps up to `count` times, stopping early when the state stops changing. */
export function run(state, count = 1) {
  let current = state;
  const total = Math.max(0, Math.trunc(toFiniteNumber(count, "count", 1)));
  for (let index = 0; index < total; index += 1) {
    const next = step(current);
    if (next === current) {
      return current;
    }
    current = next;
    if (isOver(current)) {
      return current;
    }
  }
  return current;
}
