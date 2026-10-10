// Pure, deterministic Arkanoid/Breakout rules for the pack-20261011-rerun4
// smoke task: fixed-timestep physics, wall/paddle/brick collisions, score,
// lives, and win/lose resolution. This module is deliberately DOM-free,
// timer-free, and network-free: every transition is a plain pure function,
// the serve angle comes from the injected rng, and the same inputs always
// produce the same outputs.
//
// A game state is a plain object (immutable by convention):
// - width/height: playfield size in logical pixels
// - ball:   { x, y, vx, vy } centre, velocity in pixels/second
// - paddle: { x, y, width, height } (x is the left edge; y is fixed)
// - bricks: [{ id, x, y, w, h, points, alive }, ...] (x/y are top-left)
// - remaining: alive-brick count
// - score/lives/ticks: progress counters
// - status: 'ready' | 'running' | 'paused' | 'over'
// - outcome: null | 'win' | 'lose' (set once, when status becomes 'over')
// - lastHit: { type, id? } for the most recent collision (test/UI aid)
// - rng:    seedable generator used for serve angles
// - options: options passed to createGame, replayed by restart

export const PLAYFIELD_WIDTH = 480;
export const PLAYFIELD_HEIGHT = 360;

export const BALL_RADIUS = 6;
export const BALL_SPEED = 180;
export const MAX_BALL_SPEED = 320;
// Keeps a rebounding ball from travelling almost purely horizontally.
export const MIN_VERTICAL_RATIO = 0.35;

export const PADDLE_WIDTH = 72;
export const PADDLE_HEIGHT = 12;
export const PADDLE_Y = PLAYFIELD_HEIGHT - 24;
export const PADDLE_SPEED = 320;
// Contact-offset steering range in pixels/second at the paddle edge.
export const PADDLE_SPIN = 140;

export const BRICK_COLS = 10;
export const BRICK_ROWS = 5;
export const BRICK_GAP = 4;
export const BRICK_TOP = 48;
export const BRICK_POINTS = 10;

export const LIVES = 3;
export const FIXED_DT = 1 / 120;
export const STEP_MS = 1000 / 60;

export const DIRECTIONS = Object.freeze({
  left: { dx: -1 },
  right: { dx: 1 },
});

const MAX_BALL_DT_MS = 250;

function normalizeDir(value) {
  if (typeof value === "string") return DIRECTIONS[value] ?? null;
  if (value && typeof value.dx === "number") {
    const len = Math.hypot(value.dx, value.dy ?? 0);
    if (len > 0) return { dx: value.dx / len, dy: (value.dy ?? 0) / len };
  }
  return null;
}

function createBall(x, y, vx, vy) {
  return { x, y, vx, vy };
}

// Seedable xorshift32 generator; deterministic for a given seed.
export function createRng(seed = 1) {
  let state = (Number.isSafeInteger(seed) ? seed : 1) | 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return (state >>> 0) / 4294967296;
  };
}

function clampPaddleX(paddle) {
  return Math.min(Math.max(paddle.x, 0), paddle.width - PADDLE_WIDTH);
}

function createPaddle(x) {
  const paddle = { x, y: PADDLE_Y, width: PADDLE_WIDTH, height: PADDLE_HEIGHT };
  paddle.x = clampPaddleX(paddle);
  return paddle;
}

function createBricks(options) {
  const rows = options.rows;
  const cols = options.cols;
  const gap = options.brickGap;
  const top = options.brickTop;
  const side = gap;
  const brickW = (options.width - side * 2 - gap * (cols - 1)) / cols;
  const brickH = options.brickHeight;
  const bricks = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = side + col * (brickW + gap);
      const y = top + row * (brickH + gap);
      bricks.push({
        id: `b${row}-${col}`,
        x,
        y,
        w: brickW,
        h: brickH,
        points: options.points,
        alive: true,
      });
    }
  }
  return bricks;
}

// Serve angle: deterministic from the injected rng, biased away from the
// horizontal so a new ball always reaches the bricks and the paddle.
function serveBall(state, rng) {
  const side = rng() < 0.5 ? -1 : 1;
  const angle = side * (Math.PI / 4 + (rng() - 0.5) * (Math.PI / 6));
  return createBall(
    state.paddle.x + state.paddle.width / 2,
    state.height - 60,
    Math.sin(angle) * BALL_SPEED,
    -Math.cos(angle) * BALL_SPEED,
  );
}

export function createGame(options = {}) {
  const width = options.width ?? PLAYFIELD_WIDTH;
  const height = options.height ?? PLAYFIELD_HEIGHT;
  const rows = options.rows ?? BRICK_ROWS;
  const cols = options.cols ?? BRICK_COLS;
  const ballRadius = options.ballRadius ?? BALL_RADIUS;
  const brickTop = options.brickTop ?? BRICK_TOP;
  const brickGap = options.brickGap ?? BRICK_GAP;
  const brickHeight = options.brickHeight ?? Math.max(8, Math.round(height / 24));
  const paddleWidth = options.paddleWidth ?? PADDLE_WIDTH;
  const points = options.points ?? BRICK_POINTS;

  if (!Number.isFinite(width) || width <= 0) throw new RangeError("width must be positive");
  if (!Number.isFinite(height) || height <= 0) throw new RangeError("height must be positive");
  if (!Number.isInteger(rows) || rows < 1) throw new RangeError("rows must be >= 1");
  if (!Number.isInteger(cols) || cols < 1) throw new RangeError("cols must be >= 1");
  if (!(paddleWidth > 0 && paddleWidth < width)) {
    throw new RangeError("paddleWidth must be positive and smaller than width");
  }
  if (!(ballRadius > 0)) throw new RangeError("ballRadius must be positive");
  if (!(brickGap >= 0)) throw new RangeError("brickGap must not be negative");
  if (!(brickHeight > 0)) throw new RangeError("brickHeight must be positive");
  const usableHeight = height - brickTop - rows * (brickHeight + brickGap);
  if (!(usableHeight > 4 * ballRadius)) {
    throw new RangeError("rows do not fit above the paddle band");
  }
  // Tunnelling guard: one fixed step must move the ball less than its radius
  // so it cannot skip past a wall, the paddle band, or a brick row.
  if (!(MAX_BALL_SPEED * FIXED_DT < ballRadius)) {
    throw new RangeError("ball moves too far per fixed step for its radius");
  }

  const normalized = {
    ...options,
    width,
    height,
    rows,
    cols,
    ballRadius,
    brickTop,
    brickGap,
    brickHeight,
    paddleWidth,
    points,
  };
  const rng = normalized.rng ?? createRng(normalized.seed ?? 1);
  const bricks = createBricks(normalized);
  const paddle = createPaddle(width / 2 - paddleWidth / 2);

  return {
    ...normalized,
    ball: createBall(
      width / 2,
      Math.max(ballRadius + 1, height - 60),
      0,
      0,
    ),
    paddle,
    bricks,
    remaining: bricks.length,
    score: 0,
    lives: LIVES,
    ticks: 0,
    status: "ready",
    outcome: null,
    lastHit: null,
    rng,
    options: normalized,
  };
}

function clone(state) {
  return {
    ...state,
    ball: { ...state.ball },
    paddle: { ...state.paddle },
    bricks: state.bricks.map((brick) => ({ ...brick })),
  };
}

// Enforces the speed cap and the minimum vertical component so reflections
// cannot leave the ball stuck travelling along one brick row.
function normalizeBall(ball, speed) {
  ball.vx = speed.dx;
  ball.vy = speed.dy;
}

function clampSpeed(ball) {
  let speed = Math.hypot(ball.vx, ball.vy);
  if (!(speed > 0)) return;
  if (speed > MAX_BALL_SPEED) {
    const factor = MAX_BALL_SPEED / speed;
    ball.vx *= factor;
    ball.vy *= factor;
    speed = MAX_BALL_SPEED;
  }
  const minVy = MIN_VERTICAL_RATIO * speed;
  const sign = ball.vy === 0 ? -1 : Math.sign(ball.vy);
  if (Math.abs(ball.vy) < minVy) {
    ball.vy = sign * minVy;
    const maxVx = Math.sqrt(Math.max(0, speed * speed - ball.vy * ball.vy));
    ball.vx = (ball.vx === 0 ? 1 : Math.sign(ball.vx)) * maxVx;
  }
  normalizeBall(ball, { dx: ball.vx, dy: ball.vy });
}

function overlapsBall(brick, ball, radius) {
  const nearestX = Math.min(Math.max(ball.x, brick.x), brick.x + brick.w);
  const nearestY = Math.min(Math.max(ball.y, brick.y), brick.y + brick.h);
  const dx = ball.x - nearestX;
  const dy = ball.y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function resolveBrick(state, brick) {
  const { ball } = state;
  const radius = state.ballRadius;
  const nearestX = Math.min(Math.max(ball.x, brick.x), brick.x + brick.w);
  const nearestY = Math.min(Math.max(ball.y, brick.y), brick.y + brick.h);
  const dx = ball.x - nearestX;
  const dy = ball.y - nearestY;
  const horizontal = dx !== 0 && dy === 0 ? true : dx === 0 && dy !== 0 ? false : Math.abs(dx) >= Math.abs(dy);
  if (horizontal) {
    ball.vx = dx >= 0 ? Math.abs(ball.vx) : -Math.abs(ball.vx);
    ball.x = dx >= 0 ? brick.x + brick.w + radius : brick.x - radius;
  } else {
    ball.vy = dy >= 0 ? Math.abs(ball.vy) : -Math.abs(ball.vy);
    ball.y = dy >= 0 ? brick.y + brick.h + radius : brick.y - radius;
  }
  clampSpeed(ball);
  brick.alive = false;
  state.score += brick.points;
  state.remaining -= 1;
  state.lastHit = { type: "brick", id: brick.id };
}

function stepFixed(state) {
  const { ball, paddle } = state;
  const radius = state.ballRadius;

  ball.x += ball.vx * FIXED_DT;
  ball.y += ball.vy * FIXED_DT;

  if (ball.x - radius < 0) {
    ball.x = radius;
    ball.vx = Math.abs(ball.vx);
    state.lastHit = { type: "wall", side: "left" };
  } else if (ball.x + radius > state.width) {
    ball.x = state.width - radius;
    ball.vx = -Math.abs(ball.vx);
    state.lastHit = { type: "wall", side: "right" };
  }
  if (ball.y - radius < 0) {
    ball.y = radius;
    ball.vy = Math.abs(ball.vy);
    state.lastHit = { type: "wall", side: "top" };
  }

  // Paddle: only a descending ball is caught, and it is pushed back above the
  // paddle band so it cannot re-collide on the following tick.
  const paddleTop = paddle.y;
  const withinPaddle =
    ball.x + radius >= paddle.x && ball.x - radius <= paddle.x + paddle.width;
  if (
    ball.vy > 0 &&
    withinPaddle &&
    ball.y + radius >= paddleTop &&
    ball.y - radius <= paddleTop + paddle.height
  ) {
    const centre = paddle.x + paddle.width / 2;
    const offset = Math.min(1, Math.max(-1, (ball.x - centre) / (paddle.width / 2)));
    const speed = Math.min(MAX_BALL_SPEED, Math.hypot(ball.vx, ball.vy));
    ball.vy = -Math.abs(ball.vy);
    ball.vx = ball.vx + offset * PADDLE_SPIN;
    ball.y = paddleTop - radius;
    clampSpeed(ball);
    state.lastHit = { type: "paddle", offset };
  }

  // Bricks: exactly one resolution per step so a single tick can never score
  // two bricks, and a destroyed brick can never score again.
  for (const brick of state.bricks) {
    if (!brick.alive) continue;
    if (!overlapsBall(brick, ball, radius)) continue;
    resolveBrick(state, brick);
    break;
  }

  state.ticks += 1;

  if (state.remaining === 0) {
    state.status = "over";
    state.outcome = "win";
    state.lastHit = { type: "win" };
    return state;
  }

  // Floor: the ball is gone. Lose a life and serve, or end the game.
  if (ball.y - radius > state.height) {
    state.lives -= 1;
    state.lastHit = { type: "floor" };
    if (state.lives <= 0) {
      state.lives = 0;
      state.status = "over";
      state.outcome = "lose";
      return state;
    }
    state.ball = serveBall(state, state.rng);
    return state;
  }

  return state;
}

export function step(state, dtMs = 0) {
  if (!state || state.status !== "running") return state;
  const next = clone(state);
  const ms = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, MAX_BALL_DT_MS) : 0;
  const substeps = Math.round(ms / (STEP_MS * FIXED_DT * 1000));
  const count = ms > 0 ? Math.max(1, substeps) : 1;
  for (let index = 0; index < count; index += 1) {
    stepFixed(next);
    if (next.status === "over") break;
  }
  return next;
}

export function run(state, count = 1) {
  let current = state;
  for (let index = 0; index < count; index += 1) {
    if (isOver(current)) break;
    current = step(current);
  }
  return current;
}

export function start(state) {
  if (!state || state.status !== "ready") return state;
  const next = clone(state);
  next.status = "running";
  next.ball = serveBall(next, next.rng);
  next.lastHit = { type: "serve" };
  return next;
}

// Serves a fresh deterministic ball without starting the game.
export function serve(state) {
  if (!state || state.status !== "ready") return state;
  const next = clone(state);
  next.ball = serveBall(next, next.rng);
  next.lastHit = { type: "serve" };
  return next;
}

export function pause(state) {
  if (!state || state.status !== "running") return state;
  const next = clone(state);
  next.status = "paused";
  return next;
}

export function resume(state) {
  if (!state || state.status !== "paused") return state;
  const next = clone(state);
  next.status = "running";
  return next;
}

export function restart(state) {
  const options = state?.options ?? {};
  return start(createGame(options));
}

export function isOver(state) {
  return Boolean(state && state.status === "over");
}

export function movePaddle(state, dx) {
  if (!state) return state;
  const amount = Number.isFinite(dx) ? dx : 0;
  const next = clone(state);
  next.paddle.x = Math.min(Math.max(next.paddle.x + amount, 0), next.width - next.paddle.width);
  return next;
}

export function setPaddleTarget(state, targetX) {
  if (!state) return state;
  const centre = Number.isFinite(targetX) ? targetX : state.paddle.x + state.paddle.width / 2;
  const next = clone(state);
  next.paddle.x = Math.min(
    Math.max(centre - next.paddle.width / 2, 0),
    next.width - next.paddle.width,
  );
  return next;
}

// Horizontal paddle motion for one requestAnimationFrame frame, given the
// keyboard directions currently held down.
export function movePaddleByDirections(state, directions, dtMs = 1000 / 60) {
  if (!state || state.status === "over") return state;
  if (!directions || directions.size === 0) return state;

export const PADDLE_MIN_X = 0;

export function paddleBounds(state) {
  return { minX: 0, maxX: state.width - state.paddle.width };
}
