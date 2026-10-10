// Pure, deterministic Arkanoid/Breakout engine.
//
// The engine is a plain-object functional state machine: every exported
// function returns a brand new state object and never mutates its input, so
// physics are unit-testable in Node with `node --test`. It has no DOM,
// canvas, timers, requestAnimationFrame, Date, Math.random, window, document
// or fetch access: all randomness (the serve angle) comes from the injected
// `rng`, and the only time source is the fixed `dt` handed to `step` /
// `advance` / `advanceBall` by main.mjs. Rendering, input, and the
// requestAnimationFrame loop live in main.mjs.
//
// State shape:
// {
//   width, height,                       // logical playfield size (px)
//   ball:   { x, y, vx, vy, radius },    // centre position + velocity (px/s)
//   paddle: { x, y, width, height, speed, velocity, lastSeenX },
//   bricks: [{ id, x, y, width, height, points, alive }],
//   score, lives, level,
//   status: 'ready' | 'running' | 'paused' | 'over',
//   outcome: null | 'win' | 'lose',
//   time, steps,                         // simulated seconds / fixed steps
//   rng, options
// }
//
// All physics uses the single fixed `STEP_MS` timestep exported here; main.mjs
// accumulates real frame time and consumes it in whole fixed steps, so a
// replayed sequence of steps produces identical results in the browser and in
// Node.

export const PLAYFIELD_WIDTH = 640;
export const PLAYFIELD_HEIGHT = 480;

export const BRICK_COLUMNS = 10;
export const BRICK_ROWS = 5;
export const BRICK_TOP = 60;
export const BRICK_SIDE_MARGIN = 20;
export const BRICK_GAP = 6;
export const BRICK_HEIGHT = 18;
export const BRICK_POINTS = [7, 5, 4, 3, 2]; // row 0 (top) .. row 4.

export const LIVES = 3;
export const LEVEL = 1;

export const BALL_RADIUS = 6;
export const BASE_BALL_SPEED = 240; // px/s
export const MAX_BALL_SPEED = 420; // px/s
export const MIN_VERTICAL_RATIO = 0.35; // keeps the ball out of flat loops.
export const BALL_SPEED_PER_LEVEL = 24; // px/s added per level.

export const PADDLE_WIDTH = 80;
export const PADDLE_HEIGHT = 12;
export const PADDLE_SPEED = 360; // px/s for keyboard input and auto-tracking
export const PADDLE_BOTTOM_GAP = 24;
export const PADDLE_MAX_BOUNCE_ANGLE = (50 * Math.PI) / 180;
export const PADDLE_TRACK_MARGIN = 8; // px of tracking tolerance

export const MAX_STEP_MS = 100; // longest trustworthy fixed step
export const DEFAULT_STEP_MS = 1000 / 120; // 8.333ms -> ~2.9px travel per step
export const STEP_MS = DEFAULT_STEP_MS;

const DEG = 180 / Math.PI;
const EPSILON = 1e-9;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

function hypot(vx, vy) {
  return Math.sqrt(vx * vx + vy * vy);
}

function finite(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number, received ${String(value)}`);
  }
  return value;
}

function integer(value, fallback, label, min, max) {
  const result = Math.round(finite(value, fallback, label));
  if (result < min || result > max) {
    throw new RangeError(`${label} must be between ${min} and ${max}, received ${String(value)}`);
  }
  return result;
}

/**
 * Seedable xorshift32 RNG, matching the snake example so games created with
 * the same seed reproduce identical serve angles.
 */
export function createRng(seed = 1) {
  let state = (seed >>> 0) || 0x6d2b79f5;
  return function rng() {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

export function createBricks(options = {}) {
  const width = finite(options.width, PLAYFIELD_WIDTH, "width");
  const height = finite(options.height, PLAYFIELD_HEIGHT, "height");
  const columns = integer(options.columns, BRICK_COLUMNS, "columns", 1, 64);
  const rows = integer(options.rows, BRICK_ROWS, "rows", 1, 32);
  const top = clamp(finite(options.brickTop, BRICK_TOP, "brickTop"), 0, height);
  const sideMargin = clamp(finite(options.brickSideMargin, BRICK_SIDE_MARGIN, "brickSideMargin"), 0, width / 2);
  const gap = clamp(finite(options.brickGap, BRICK_GAP, "brickGap"), 0, 40);
  const brickHeight = clamp(finite(options.brickHeight, BRICK_HEIGHT, "brickHeight"), 1, 60);
  const brickWidth = (width - sideMargin * 2 - gap * (columns - 1)) / columns;
  const rowPoints = Array.isArray(options.brickPoints) ? options.brickPoints : BRICK_POINTS;

  if (brickWidth <= 0) {
    throw new RangeError("brick layout does not fit the requested playfield width");
  }

  const bricks = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      bricks.push({
        id: row * columns + column,
        x: round(sideMargin + column * (brickWidth + gap)),
        y: round(top + row * (brickHeight + gap)),
        width: round(brickWidth),
        height: brickHeight,
        points: finite(rowPoints[row], 1, "brickPoints"),
        alive: true,
      });
    }
  }
  return bricks;
}

export function isOver(state) {
  return Boolean(state) && state.status === "over";
}

export function isPaused(state) {
  return Boolean(state) && state.status === "paused";
}

function bricksAlive(bricks) {
  return bricks.some((brick) => brick.alive);
}

function normalizeBall(ball, speed) {
  const cap = Math.min(finite(speed, BASE_BALL_SPEED, "ballSpeed"), MAX_BALL_SPEED);
  let vx = finite(ball.vx, 0, "ball.vx");
  let vy = finite(ball.vy, 0, "ball.vy");

  const current = hypot(vx, vy);
  if (current === 0) {
    vx = 0;
    vy = -cap;
  } else {
    const scale = cap / current;
    vx *= scale;
    vy *= scale;
  }

  // Keep a usable vertical component so the ball can never lock into a
  // near-horizontal loop, while preserving both velocity signs.
  const minVertical = cap * MIN_VERTICAL_RATIO;
  if (Math.abs(vy) < minVertical) {
    const verticalSign = vy === 0 ? -1 : Math.sign(vy);
    vy = verticalSign * minVertical;
    const horizontal = Math.sqrt(Math.max(cap * cap - vy * vy, 0));
    vx = (vx === 0 ? 1 : Math.sign(vx)) * horizontal;
  }

  return { ...ball, vx: round(vx), vy: round(vy) };
}

function ballSpeed(state) {
  const base = finite(state.options.ballSpeed, BASE_BALL_SPEED, "ballSpeed");
  const levels = Math.max(0, (state.level || 1) - 1);
  return Math.min(base + levels * BALL_SPEED_PER_LEVEL, MAX_BALL_SPEED);
}

function serveBall(state) {
  const { width, height, paddle } = state;
  const radius = state.ball.radius;
  const spread = finite(state.options.serveSpread, 0.35, "serveSpread");
  const upAngle = Math.PI / 2 + (state.rng() * 2 - 1) * spread;
  const speed = ballSpeed(state);

  const x = clamp(paddle.x + paddle.width / 2, radius, width - radius);
  const y = clamp(paddle.y - radius - 1, radius, height - radius);

  return normalizeBall(
    { ...state.ball, x: round(x), y: round(y), vx: round(speed * Math.sin(upAngle)), vy: round(-speed * Math.cos(upAngle)) },
    speed,
  );
}

function sweptCircleAabb({ x, y, travelX, travelY, radius, brick }) {
  // Expand the rectangle by the ball radius and ray-cast the ball centre
  // through the resulting slab box. The slab entered last is the face that was
  // struck, which is the collision normal, so corner grazes resolve the same
  // way every time.
  const minX = brick.x - radius;
  const minY = brick.y - radius;
  const maxX = brick.x + brick.width + radius;
  const maxY = brick.y + brick.height + radius;

  if (x < minX || x > maxX || y < minY || y > maxY) {
    // Outside the expanded box: a ray-cast from outside is what we want.
  }

  let tMin = 0;
  let tMax = 1;
  let normalAxis = null;
  let normalSide = null;

  const axes = [
    ["x", x, travelX, minX, maxX],
    ["y", y, travelY, minY, maxY],
  ];

  for (const [axis, origin, travel, lo, hi] of axes) {
    if (Math.abs(travel) < EPSILON) {
      if (origin < lo || origin > hi) return null;
      continue;
    }

    let enter = (lo - origin) / travel;
    let exit = (hi - origin) / travel;
    let enterSide = "min";
    if (travel < 0) {
      const swap = enter;
      enter = exit;
      exit = swap;
      enterSide = "max";
    }

    if (enter > tMin + EPSILON) {
      tMin = enter;
      normalAxis = axis;
      normalSide = enterSide;
    } else if (enter > tMin && normalAxis === null) {
      tMin = enter;
      normalAxis = axis;
      normalSide = enterSide;
    }
    tMax = Math.min(tMax, exit);
    if (tMin > tMax + EPSILON) return null;
  }

  if (!(tMin > EPSILON) || tMin > 1 || normalAxis === null) return null;

  return { axis: normalAxis, side: normalSide === "min" ? "near" : "far", brick, t: tMin };
}

function earliestHit({ x, y, travelX, travelY, radius, width, height, bricks }) {
  let best = null;
  const consider = (t, hit) => {
    if (!Number.isFinite(t) || t <= EPSILON || t > 1) return;
    if (!best || t < best.t - 1e-12) best = { ...hit, t };
  };

  if (travelX < 0) consider((radius - x) / travelX, { type: "wall", axis: "x", side: "near" });
  if (travelX > 0) consider((width - radius - x) / travelX, { type: "wall", axis: "x", side: "far" });
  if (travelY < 0) consider((radius - y) / travelY, { type: "wall", axis: "y", side: "near" });

  for (const brick of bricks) {
    if (!brick.alive) continue;
    const hit = sweptCircleAabb({ x, y, travelX, travelY, radius, brick });
    if (hit) consider(hit.t, { type: "brick", ...hit });
  }

  return best;
}

function resolveBricks(state, hits) {
  let score = state.score;
  let bricks = state.bricks;
  for (const hit of hits) {
    const index = hit.brick.id;
    const brick = bricks[index];
    if (brick && brick.alive) {
      // Credit and clear in the same move: a dead brick can never score again.
      score += brick.points;
      bricks = bricks.map((item, i) => (i === index ? { ...item, alive: false } : item));
    }
  }
  return { score, bricks };
}

function paddleBounce(state) {
  const { ball, paddle, width } = state;
  const radius = ball.radius;
  const top = paddle.y;
  const bottom = paddle.y + paddle.height;

  const overlappingY = ball.y + radius >= top && ball.y - radius <= bottom;
  const withinX = ball.x + radius >= paddle.x && ball.x - radius <= paddle.x + paddle.width;
  if (!(ball.vy > 0 && overlappingY && withinX)) return null;

  // The fastest legal ball travels MAX_BALL_SPEED * MAX_STEP_MS / 1000 = 35px
  // per step, so this band (radius + height = 17px plus sub-stepping) always
  // catches it: no paddle tunneling at any trustworthy frame step.
  const centre = paddle.x + paddle.width / 2;
  const offset = clamp((ball.x - centre) / (paddle.width / 2), -1, 1);
  const angle = offset * PADDLE_MAX_BOUNCE_ANGLE;
  const speed = Math.min(hypot(ball.vx, ball.vy), MAX_BALL_SPEED);

  return {
    ...state,
    ball: {
      ...ball,
      x: round(clamp(ball.x, radius, width - radius)),
      y: round(top - radius),
      vx: round(speed * Math.sin(angle)),
      vy: round(-speed * Math.cos(angle)),
    },
  };
}

/** Advance the ball by exactly one fixed dt. Returns the same object when idle. */
export function step(state, options = {}) {
  if (!state || state.status !== "running") return state;

  const rawDt = options.dtMs === undefined ? STEP_MS : options.dtMs;
  const dt = clamp(finite(rawDt, STEP_MS, "dtMs"), 0, MAX_STEP_MS);

  const { width, height } = state;
  const radius = state.ball.radius;
  const speed = ballSpeed(state);

  let ball = { ...state.ball, x: finite(state.ball.x, 0, "ball.x"), y: finite(state.ball.y, 0, "ball.y") };
  ball = normalizeBall(ball, speed);

  let next = { ...state, time: round(state.time + dt / 1000), steps: state.steps + 1 };
  const travelX = ball.vx * (dt / 1000);
  const travelY = ball.vy * (dt / 1000);

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const hit = earliestHit({
      x: ball.x,
      y: ball.y,
      travelX,
      travelY,
      radius,
      width,
      height,
      bricks: next.bricks,
    });

    if (!hit) {
      ball = { ...ball, x: round(ball.x + travelX), y: round(ball.y + travelY) };
      break;
    }

    ball = { ...ball, x: round(ball.x + travelX * hit.t), y: round(ball.y + travelY * hit.t) };

    if (hit.type === "wall") {
      if (hit.axis === "x") {
        ball = { ...ball, x: hit.side === "near" ? radius : width - radius, vx: -ball.vx };
      } else {
        ball = { ...ball, y: radius, vy: -ball.vy };
      }
      continue;
    }

    const resolved = resolveBricks(next, [hit]);
    next = { ...next, score: resolved.score, bricks: resolved.bricks };

    // Back the ball off a hair so the same face cannot be re-detected.
    const pad = 1e-3;
    if (hit.axis === "y") {
      const surface = hit.side === "near" ? hit.brick.y + hit.brick.height : hit.brick.y;
      ball = {
        ...ball,
        y: hit.side === "near" ? round(surface + radius + pad) : round(surface - radius - pad),
        vy: -ball.vy,
      };
    } else {
      const surface = hit.side === "near" ? hit.brick.x + hit.brick.width : hit.brick.x;
      ball = {
        ...ball,
        x: hit.side === "near" ? round(surface + radius + pad) : round(surface - radius - pad),
        vx: -ball.vx,
      };
    }
  }

  next = { ...next, ball };

  if (next.ball.y - radius >= height) {
    const lives = next.lives - 1;
    if (lives <= 0) {
      return {
        ...next,
        lives: 0,
        status: "over",
        outcome: "lose",
        ball: { ...next.ball, y: round(height + radius), vy: Math.abs(next.ball.vy) },
      };
    }
    // A lost ball is replaced by a fresh serve from the seeded rng.
    return { ...next, lives, ball: serveBall(next) };
  }

  const bounced = paddleBounce(next);
  if (bounced) return { ...next, ball: bounced.ball };

  if (!bricksAlive(next.bricks)) {
    return { ...next, status: "over", outcome: "win" };
  }

  return { ...next, ball: normalizeBall(next.ball, speed) };
}

/**
 * Automatic paddle tracking. The paddle steers toward `targetX` at paddle
 * speed, capped by the per-step travel so it can never teleport, and stops
 * inside a `margin` tolerance band so the ball is struck across the face
 * rather than always dead centre. Keyboard and pointer input set the paddle
 * position directly, so a human always overrides tracking.
 */
export function trackPaddle(state, dtMs = STEP_MS, options = {}) {
  if (!state) return state;
  const paddle = state.paddle;
  const dtSeconds = clamp(finite(dtMs, STEP_MS, "dtMs"), 0, MAX_STEP_MS) / 1000;
  const margin = clamp(finite(options.margin, PADDLE_TRACK_MARGIN, "margin"), 0, state.width);
  const targetX = finite(options.targetX, paddle.lastSeenX ?? state.ball.x, "targetX");

  const centre = paddle.x + paddle.width / 2;
  const desired = clamp(targetX, paddle.width / 2, Math.max(paddle.width / 2, state.width - paddle.width / 2));
  const delta = desired - centre;
  if (Math.abs(delta) <= margin) return state;

  const maxTravel = clamp(finite(paddle.speed, PADDLE_SPEED, "paddle.speed"), 0, 6000) * dtSeconds;
  const travel = clamp(delta, -maxTravel, maxTravel);
  if (travel === 0) return state;
  return movePaddle(state, travel);
}

/** One fixed physics step plus paddle tracking (the main-loop primitive). */
export function advanceBall(state, options = {}) {
  const stepped = step(state, options);
  if (stepped === state) return stepped;
  return trackPaddle(stepped, finite(options.dtMs, STEP_MS, "dtMs"), {
    targetX: stepped.ball.x,
    margin: finite(options.trackMargin, PADDLE_TRACK_MARGIN, "trackMargin"),
  });
}

export function advance(state, steps = 1, options = {}) {
  let current = state;
  const count = Math.max(0, Math.floor(finite(steps, 1, "steps")));
  for (let index = 0; index < count; index += 1) {
    const next = step(current, options);
    if (next === current) break; // paused / over / ready: nothing to advance
    current = next;
  }
  return current;
}

/** Begin a rally: serves a ball, and restarts a finished game. */
export function start(state) {
  if (!state) return state;
  if (state.status === "running") return state;
  if (state.status === "paused") return { ...state, status: "running" };
  if (state.status === "over") return restart(state.options);
  return { ...state, status: "running", outcome: null, ball: serveBall(state) };
}

export function pause(state) {
  if (!state || state.status !== "running") return state;
  return { ...state, status: "paused" };
}

export function resume(state) {
  if (!state || state.status !== "paused") return state;
  return { ...state, status: "running" };
}

export function togglePause(state) {
  if (!state) return state;
  if (state.status === "running") return pause(state);
  if (state.status === "paused") return resume(state);
  return state;
}

/** Build a brand new board from options and serve immediately. */
export function restart(options = {}) {
  return start(createGame(options));
}

/** Re-serve a fresh ball and refill lives for a new rally. */
export function serve(state) {
  if (!state) return state;
  return {
    ...state,
    lives: integer(state.options.lives, LIVES, "lives", 0, 99),
    status: "running",
    outcome: null,
    ball: serveBall(state),
  };
}

export function movePaddle(state, dx) {
  if (!state) return state;
  const paddle = state.paddle;
  const x = clamp(paddle.x + finite(dx, 0, "dx"), 0, Math.max(0, state.width - paddle.width));
  return { ...state, paddle: { ...paddle, x: round(x) } };
}

export function movePaddleBy(state, dx, options = {}) {
  const dt = clamp(finite(options.dtMs, STEP_MS, "dtMs"), 0, MAX_STEP_MS);
  const moved = movePaddle(state, dx);
  if (moved === state) return state;
  return { ...moved, paddle: { ...moved.paddle, velocity: moved.paddle.velocity ?? 0 }, time: state.time, steps: state.steps, dt };
}

export function setPaddleCenter(state, center) {
  if (!state) return state;
  const paddle = state.paddle;
  const centre = clamp(
    finite(center, paddle.x + paddle.width / 2, "center"),
    paddle.width / 2,
    Math.max(paddle.width / 2, state.width - paddle.width / 2),
  );
  return { ...state, paddle: { ...paddle, x: round(centre - paddle.width / 2) } };
}

export function setPaddleVelocity(state, direction) {
  if (!state) return state;
  const value = clamp(finite(direction, 0, "direction"), -1, 1);
  const speed = clamp(finite(state.paddle.speed, PADDLE_SPEED, "paddle.speed"), 0, 6000);
  return { ...state, paddle: { ...state.paddle, velocity: round(value * speed) } };
}

export function setPaddleLastSeen(state, x) {
  if (!state) return state;
  return { ...state, paddle: { ...state.paddle, lastSeenX: round(clamp(finite(x, 0, "x"), 0, state.width)) } };
}

function validateBrick(brick, index) {
  if (!brick || typeof brick !== "object") {
    throw new RangeError(`brick ${index} must be an object`);
  }
  const width = finite(brick.width, NaN, `brick ${index} width`);
  const height = finite(brick.height, NaN, `brick ${index} height`);
  const x = finite(brick.x, NaN, `brick ${index} x`);
  const y = finite(brick.y, NaN, `brick ${index} y`);
  if (!(width > 0) || !(height > 0)) {
    throw new RangeError(`brick ${index} must have positive width and height`);
  }
  return {
    id: integer(brick.id, index, `brick ${index} id`, 0, Number.MAX_SAFE_INTEGER),
    x,
    y,
    width,
    height,
    points: finite(brick.points, 1, `brick ${index} points`),
    alive: brick.alive !== false,
  };
}

export function createGame(options = {}) {
  const width = clamp(finite(options.width, PLAYFIELD_WIDTH, "width"), 80, 4096);
  const height = clamp(finite(options.height, PLAYFIELD_HEIGHT, "height"), 60, 4096);
  if (width < 3 || height < 3) throw new RangeError("playfield must be at least 3x3");
  if (height <= width * 0.15) throw new RangeError("playfield is too short to play");

  const radius = clamp(finite(options.ballRadius, BALL_RADIUS, "ballRadius"), 1, Math.min(width, height) / 8);
  const paddleWidth = clamp(finite(options.paddleWidth, PADDLE_WIDTH, "paddleWidth"), 4, width);
  if (!(paddleWidth > 0)) throw new RangeError("paddleWidth must be positive");
  const paddleHeight = clamp(finite(options.paddleHeight, PADDLE_HEIGHT, "paddleHeight"), 1, height / 8);
  const paddleY = clamp(
    finite(options.paddleY, height - PADDLE_BOTTOM_GAP - paddleHeight, "paddleY"),
    0,
    height - paddleHeight,
  );
  const speed = clamp(finite(options.ballSpeed, BASE_BALL_SPEED, "ballSpeed"), 1, MAX_BALL_SPEED);
  const lives = integer(options.lives, LIVES, "lives", 0, 99);

  const rng = typeof options.rng === "function" ? options.rng : createRng(finite(options.seed, 1, "seed"));

  const bricks = Array.isArray(options.bricks)
    ? options.bricks.map((brick, index) => validateBrick(brick, index))
    : createBricks({ ...options, width, height });

  const paddle = {
    x: round(clamp(finite(options.paddleX, width / 2 - paddleWidth / 2, "paddleX"), 0, width - paddleWidth)),
    y: round(paddleY),
    width: round(paddleWidth),
    height: round(paddleHeight),
    speed: clamp(finite(options.paddleSpeed, PADDLE_SPEED, "paddleSpeed"), 0, 6000),
    velocity: 0,
    lastSeenX: round(width / 2),
  };

  const ball = {
    x: round(clamp(finite(options.ballX, width / 2, "ballX"), radius, width - radius)),
    y: round(clamp(finite(options.ballY, paddleY - radius - 1, "ballY"), radius, height - radius)),
    vx: finite(options.ballVx, 0, "ballVx"),
    vy: finite(options.ballVy, 0, "ballVy"),
    radius: round(radius),
  };

  const status = options.status === undefined ? "ready" : String(options.status);
  if (!["ready", "running", "paused", "over"].includes(status)) {
    throw new RangeError(`unknown status ${status}`);
  }

  const state = {
    width: round(width),
    height: round(height),
    ball,
    paddle,
    bricks,
    score: finite(options.score, 0, "score"),
    lives,
    level: integer(options.level, LEVEL, "level", 1, 999),
    status,
    outcome: options.outcome ?? null,
    time: finite(options.time, 0, "time"),
    steps: finite(options.steps, 0, "steps"),
    rng,
    options: {
      ...options,
      width,
      height,
      ballSpeed: speed,
      lives,
      ballRadius: radius,
      paddleWidth,
      paddleHeight,
      paddleY,
      paddleSpeed: paddle.speed,
    },
  };

  // A running board always serves through the seeded rng so the rally is
  // reproducible; a caller that wants exact ball velocities passes them in
  // with ballX/ballY/ballVx/ballVy plus status "running".
  const explicitVelocity = options.ballVx !== undefined || options.ballVy !== undefined;
  if (state.status === "running" && !explicitVelocity) {
    state.ball = serveBall(state);
  } else {
    state.ball = normalizeBall(state.ball, ballSpeed(state));
  }

  return state;
}

export function summarize(state) {
  return {
    status: state.status,
    outcome: state.outcome,
    score: state.score,
    lives: state.lives,
    level: state.level,
    steps: state.steps,
    bricksLeft: state.bricks.filter((brick) => brick.alive).length,
    ball: { ...state.ball },
    paddle: { ...state.paddle },
  };
}

export function describeAngle(ball) {
  return round(Math.atan2(-finite(ball.vy, 0, "ball.vy"), finite(ball.vx, 0, "ball.vx")) * DEG);
}
