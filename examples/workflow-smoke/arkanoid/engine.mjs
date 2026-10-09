// Deterministic, DOM-free Arkanoid / Breakout rules.
//
// This module has zero imports and never touches window, document, canvas,
// Date or Math.random. Every result depends only on the state and inputs that
// callers pass in, so the same rules drive the browser shell and the Node
// test suite and remain bit-for-bit reproducible.

export const FIXED_STEP = 1 / 120;

export const STATUS = Object.freeze({
  READY: 'ready',
  RUNNING: 'running',
  PAUSED: 'paused',
  WON: 'won',
  LOST: 'lost',
});

export const BRICK_SCORE = 7;

export const MIN_SPEED = 1;
export const MAX_SPEED = 240;

// Fraction of the paddle half-width that still produces a bounce angle.
const PADDLE_SPIN = 0.9;

function normalizeAngle(angle) {
  const twoPi = Math.PI * 2;
  let value = angle % twoPi;
  if (value < 0) {
    value += twoPi;
  }
  return value;
}

function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function createGame(config = {}) {
  const width = config.width ?? 640;
  const height = config.height ?? 480;

  const state = {
    width,
    height,
    wallLeftMargin: config.wallLeftMargin ?? 0,
    wallRightMargin: config.wallRightMargin ?? 0,
    wallTopMargin: config.wallTopMargin ?? 0,
    ballRadius: config.ballRadius ?? 8,
    fixedStep: config.fixedStep ?? FIXED_STEP,
    maxSubSteps: positiveInt(config.maxSubSteps, 64),
    paddle: {
      width: config.paddleWidth ?? 80,
      height: config.paddleHeight ?? 14,
      x: 0,
      y: 0,
      targetX: null,
      speed: config.paddleSpeed ?? 320,
    },
    ball: {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      speed: config.launchSpeed ?? 150,
      minSpeed: config.minSpeed ?? MIN_SPEED,
      maxSpeed: config.maxSpeed ?? MAX_SPEED,
      bounceSpeed: config.bounceSpeed ?? 150,
      angle: Math.PI / 4,
    },
    bricks: [],
    brickWidth: config.brickWidth ?? 0,
    brickHeight: config.broadHeight ?? config.brickHeight ?? 20,
    brickColumns: 0,
    score: 0,
    brickScore: config.brickScore ?? BRICK_SCORE,
    lives: config.lives ?? 3,
    status: STATUS.READY,
  };

  state.brickColumns = positiveInt(config.brickColumns, 8);
  const rows = positiveInt(config.brickRows, 5);
  const columnGap = config.brickColumnGap ?? 4;
  const rowGap = config.brickRowGap ?? 4;

  if (!('brickWidth' in config) && config.brickWidth === undefined) {
    state.brickWidth = (width - columnGap) / state.brickColumns - columnGap;
  } else {
    state.brickWidth = config.brickWidth;
  }

  state.bricks = buildBricks(state, { rows, columnGap, rowGap });
  resetLayout(state);
  return state;
}

export function buildBricks(configOrState, options = {}) {
  const isState = Array.isArray(configOrState.bricks);
  const width = isState ? configOrState.width : (configOrState.width ?? 640);
  const columns = isState
    ? configOrState.brickColumns
    : positiveInt(configOrState.brickColumns, 8);
  const brickWidth = isState
    ? configOrState.brickWidth
    : (configOrState.brickWidth ?? ((width - 4) / columns - 4));
  const brickHeight = isState ? configOrState.brickHeight : (configOrState.brickHeight ?? 20);
  const rows = positiveInt(options.rows, isState ? positiveInt(configOrState.brickRows, 5) : 5);
  const columnGap = options.columnGap ?? (isState ? 4 : (configOrState.brickColumnGap ?? 4));
  const rowGap = options.rowGap ?? (isState ? 4 : (configOrState.brickRowGap ?? 4));
  const top = options.top ?? (isState ? configOrState.wallTopMargin ?? 0 : (configOrState.brickTop ?? 60));
  const left = options.left ?? (isState ? configOrState.wallLeftMargin ?? 0 : (configOrState.brickLeft ?? 0));

  const bricks = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      bricks.push({
        id: `${row}x${column}`,
        row,
        col: column,
        x: left + column * (brickWidth + columnGap),
        y: top + row * (brickHeight + rowGap),
        width: brickWidth,
        height: brickHeight,
        alive: true,
      });
    }
  }
  return bricks;
}

function resetLayout(state) {
  const { paddle, ball } = state;
  paddle.x = state.width / 2 - paddle.width / 2;
  paddle.y = state.height - paddle.height;
  paddle.targetX = null;
  state.score = 0;
  state.lives = state.lives === undefined ? 3 : state.lives;
  serveBall(state);
  return state;
}

export function cloneState(state) {
  return {
    ...state,
    paddle: { ...state.paddle },
    ball: { ...state.ball },
    bricks: state.bricks.map((brick) => ({ ...brick })),
  };
}

export function startGame(state) {
  if (state.status === STATUS.PAUSED) {
    state.status = STATUS.RUNNING;
    return state;
  }
  if (state.status === STATUS.READY) {
    launchBall(state);
  }
  state.status = STATUS.RUNNING;
  return state;
}

export function pauseGame(state) {
  if (state.status === STATUS.RUNNING) {
    state.status = STATUS.PAUSED;
  }
  return state;
}

export function resumeGame(state) {
  if (state.status === STATUS.PAUSED) {
    state.status = STATUS.RUNNING;
  }
  return state;
}

export function restartGame(state) {
  state.score = 0;
  state.lives = 3;
  for (const brick of state.bricks) {
    brick.alive = true;
  }
  resetLayout(state);
  state.status = STATUS.READY;
  return state;
}

export function launchBall(state) {
  const { ball } = state;
  const angle = normalizeAngle(ball.angle);
  const speed = ball.speed;
  ball.vx = speed * Math.cos(angle);
  ball.vy = -speed * Math.abs(Math.sin(angle));
  clampSpeed(ball);
  return state;
}

export function serveBall(state) {
  const { paddle, ball } = state;
  ball.x = paddle.x + paddle.width / 2;
  ball.y = paddle.y - state.ballRadius - 1;
  ball.vx = 0;
  ball.vy = 0;
  return state;
}

export function movePaddle(state, dx) {
  const distance = Number.isFinite(dx) ? dx : 0;
  const minX = state.wallLeftMargin;
  const maxX = state.width - state.wallRightMargin - state.paddle.width;
  state.paddle.x = Math.min(Math.max(state.paddle.x + distance, minX), Math.max(minX, maxX));
  state.paddle.targetX = null;
  return state;
}

export function setPaddleTarget(state, targetX) {
  if (!Number.isFinite(targetX)) {
    return state;
  }
  state.paddle.targetX = targetX;
  return state;
}

function stepPaddle(state, dt) {
  const { paddle } = state;
  const minX = state.wallLeftMargin;
  const maxX = state.width - state.wallRightMargin - paddle.width;
  const right = Math.max(minX, maxX);

  if (paddle.targetX !== null && paddle.targetX !== undefined) {
    const remaining = paddle.targetX - paddle.x;
    const maxMove = paddle.speed * dt;
    if (Math.abs(remaining) <= maxMove) {
      paddle.x = paddle.targetX;
    } else {
      paddle.x += Math.sign(remaining) * maxMove;
    }
  }
  paddle.x = Math.min(Math.max(paddle.x, minX), right);
  return state;
}

export function clampSpeed(ball) {
  const min = ball.minSpeed;
  const max = ball.maxSpeed;
  const current = Math.hypot(ball.vx, ball.vy);
  if (current === 0) {
    return ball;
  }
  let target = current;
  if (current > max) {
    target = max;
  } else if (current < min) {
    target = min;
  }
  if (target !== current) {
    const scale = target / current;
    ball.vx *= scale;
    ball.vy *= scale;
  }
  ball.speed = target;
  return ball;
}

function aliveBricks(state) {
  return state.bricks.filter((brick) => brick.alive);
}

function reflectWalls(state) {
  const { ball } = state;
  const radius = state.ballRadius;
  const minX = state.wallLeftMargin + radius;
  const maxX = state.width - state.wallRightMargin - radius;
  const minY = state.wallTopMargin + radius;

  if (ball.x <= minX && ball.vx < 0) {
    ball.x = minX;
    ball.vx = -ball.vx;
    clampSpeed(ball);
  } else if (ball.x >= maxX && ball.vx > 0) {
    ball.x = maxX;
    ball.vx = -ball.vx;
    clampSpeed(ball);
  }

  if (ball.y <= minY && ball.vy < 0) {
    ball.y = minY;
    ball.vy = -ball.vy;
    clampSpeed(ball);
  }
}

function hitBrick(state, brick) {
  brick.alive = false;
  state.score += state.brickScore;
}

function collideBricks(state) {
  const { ball } = state;
  const radius = state.ballRadius;

  for (const brick of aliveBricks(state)) {
    const nearestX = Math.max(brick.x, Math.min(ball.x, brick.x + brick.width));
    const nearestY = Math.max(brick.y, Math.min(ball.y, brick.y + brick.height));
    const dx = ball.x - nearestX;
    const dy = ball.y - nearestY;

    if (dx * dx + dy * dy > radius * radius) {
      continue; // eslint-disable no-continue
    }

    const overlapLeft = ball.x + radius - brick.x;
    const overlapRight = brick.x + brick.width - (ball.x - radius);
    const overlapTop = ball.y + radius - brick.y;
    const overlapBottom = brick.y + brick.height - (ball.y - radius);

    const horizontalPenetration = Math.min(overlapLeft, overlapRight);
    const verticalPenetration = Math.min(overlapTop, overlapBottom);

    if (verticalPenetration <= horizontalPenetration) {
      const fromTop = ball.y < brick.y + brick.height / 2;
      ball.vy = fromTop ? -Math.abs(ball.vy) : Math.abs(ball.vy);
      ball.y = fromTop ? brick.y - radius : brick.y + brick.height + radius;
    } else {
      const fromLeft = ball.x < brick.x + brick.width / 2;
      ball.vx = fromLeft ? -Math.abs(ball.vx) : Math.abs(ball.vx);
      ball.x = fromLeft ? brick.x - radius : brick.x + brick.width + radius;
    }

    hitBrick(state, brick);
    clampSpeed(ball);
    return true;
  }
  return false;
}

function collidePaddle(state) {
  const { ball, paddle } = state;
  const radius = state.ballRadius;
  const nearestX = Math.max(paddle.x, Math.min(ball.x, paddle.x + paddle.width));
  const nearestY = Math.max(paddle.y, Math.min(ball.y, paddle.y + paddle.height));
  const dx = ball.x - nearestX;
  const dy = ball.y - nearestY;

  if (dx * dx + dy * dy > radius * radius) {
    return false;
  }

  if (ball.vy <= 0 && ball.y <= paddle.y) {
    // Already heading away from the paddle face: nothing to resolve.
    return false;
  }

  const offset = Math.max(-1, Math.min(1, (ball.x - (paddle.x + paddle.width / 2)) / (paddle.width / 2)));
  const angle = offset * PADDLE_SPIN;
  const speed = Math.max(ball.bounceSpeed, Math.hypot(ball.vx, ball.vy));
  ball.speed = speed;
  ball.vx = speed * Math.sin(angle);
  ball.vy = -speed * Math.cos(angle);
  ball.y = paddle.y - radius;
  clampSpeed(ball);
  return true;
}

function missBall(state) {
  state.lives -= 1;
  if (state.lives <= 0) {
    state.lives = 0;
    state.status = STATUS.LOST;
    state.ball.vx = 0;
    state.ball.vy = 0;
    return true;
  }
  serveBall(state);
  return false;
}

function stepBall(state, dt) {
  const { ball } = state;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  reflectWalls(state);

  if (collideBricks(state)) {
    return;
  }

  collidePaddle(state);

  if (ball.y - state.ballRadius > state.height) {
    missBall(state);
  }
}

export function stepGame(state, dt) {
  if (state.status !== STATUS.RUNNING) {
    return state;
  }

  const delta = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  if (delta === 0) {
    return state;
  }

  stepPaddle(state, delta);

  const step = state.fixedStep;
  let remaining = delta;
  let guard = state.maxSubSteps;

  while (remaining > 0 && guard > 0) {
    const slice = Math.min(step, remaining);
    stepBall(state, slice);
    remaining -= slice;
    guard -= 1;
    if (state.status !== STATUS.RUNNING) {
      break;
    }
  }

  if (aliveBricks(state).length === 0) {
    state.status = STATUS.WON;
  }

  return state;
}
