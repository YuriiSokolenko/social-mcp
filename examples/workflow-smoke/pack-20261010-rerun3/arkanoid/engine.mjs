// Deterministic Arkanoid / Breakout rules.
// Pure JavaScript only: no DOM, timers, randomness beyond the injected seed.
// Run tests: node --test examples/workflow-smoke/pack-20261010-rerun3/arkanoid/engine.test.mjs

export const FIELD_WIDTH = 480;
export const FIELD_HEIGHT = 360;

export const PADDLE_WIDTH = 64;
export const PADDLE_HEIGHT = 12;
export const PADDLE_Y = FIELD_HEIGHT - 24;
export const PADDLE_SPEED = 260;

export const BALL_RADIUS = 6;
export const BALL_SPEED = 180;
export const MAX_BALL_SPEED = 320;

export const BRICK_COLS = 8;
export const BRICK_ROWS = 5;
export const BRICK_MARGIN = 4;
export const BRICK_TOP = 40;
export const BRICK_VALUE = 10;

export const INITIAL_LIVES = 3;
export const STEP_MS = 1000 / 60;
export const FIXED_DT = STEP_MS / 1000;

const MAX_SERVE_ANGLE = Math.PI / 4;

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return number;
}

function positiveInt(value, name) {
  const number = Math.trunc(positive(value, name));
  return number;
}

export function createRng(seed = 1) {
  let state = (Number.isInteger(seed) ? seed : 1) >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

export function createBricks(options = {}) {
  const width = positive(options.width ?? FIELD_WIDTH, 'width');
  const cols = positiveInt(options.cols ?? BRICK_COLS, 'cols');
  const rows = positiveInt(options.rows ?? BRICK_ROWS, 'rows');
  const margin = Math.max(0, Number(options.brickMargin ?? BRICK_MARGIN));
  const top = Math.max(0, Number(options.brickTop ?? BRICK_TOP));

  const usable = width - margin;
  const brickWidth = (usable - margin * (cols - 1)) / cols;
  const brickHeight = positive(options.brickHeight ?? 16, 'brickHeight');

  const bricks = [];
  let id = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      bricks.push({
        id: id,
        row: row,
        col: col,
        x: margin + col * (brickWidth + margin),
        y: top + row * (brickHeight + margin),
        width: brickWidth,
        height: brickHeight,
        hits: 1,
        alive: true,
      });
      id += 1;
    }
  }
  return bricks;
}

export function createGame(options = {}) {
  const opts = { ...options };
  const width = positive(opts.width ?? FIELD_WIDTH, 'width');
  const height = positive(opts.height ?? FIELD_HEIGHT, 'height');
  if (width < 3 || height < 3) {
    throw new RangeError('Field must be at least 3 units wide and tall');
  }

  const radius = positive(opts.ballRadius ?? BALL_RADIUS, 'ballRadius');
  const paddleWidth = positive(opts.paddleWidth ?? PADDLE_WIDTH, 'paddleWidth');
  const paddleHeight = positive(opts.paddleHeight ?? PADDLE_HEIGHT, 'paddleHeight');
  if (paddleWidth >= width) {
    throw new RangeError('Paddle must be narrower than the field');
  }
  const paddleY = Number(opts.paddleY ?? PADDLE_Y);
  if (paddleY + paddleHeight > height) {
    throw new RangeError('Paddle must fit inside the field');
  }

  const bricks = Array.isArray(opts.bricks) && opts.bricks.length > 0
    ? opts.bricks.map((brick, index) => ({
      id: Number.isFinite(brick.id) ? brick.id : index,
      row: Number.isFinite(brick.row) ? brick.row : 0,
      col: Number.isFinite(brick.col) ? brick.col : index,
      x: positive(brick.x, 'brick.x'),
      y: positive(brick.y, 'brick.y'),
      width: positive(brick.width, 'brick.width'),
      height: positive(brick.height, 'brick.height'),
      hits: positiveInt(brick.hits ?? 1, 'brick.hits'),
      alive: brick.alive !== false,
    }))
    : createBricks(opts);

  const brickValue = Number.isFinite(opts.brickValue) ? opts.brickValue : BRICK_VALUE;
  const maxSpeed = positive(opts.maxBallSpeed ?? MAX_BALL_SPEED, 'maxBallSpeed');
  const speed = positive(opts.ballSpeed ?? BALL_SPEED, 'ballSpeed');
  if (maxSpeed < speed) {
    throw new RangeError('maxBallSpeed must be at least ballSpeed');
  }

  const rng = typeof opts.rng === 'function' ? opts.rng : createRng(opts.seed ?? 1);
  const lives = positiveInt(opts.lives ?? INITIAL_LIVES, 'lives');

  const state = {
    width,
    height,
    paddle: {
      x: (width - paddleWidth) / 2,
      y: paddleY,
      width: paddleWidth,
      height: paddleHeight,
      vx: 0,
    },
    ball: { x: 0, y: 0, vx: 0, vy: 0, radius },
    bricks,
    bricksTotal: bricks.length,
    bricksLeft: bricks.filter((brick) => brick.alive).length,
    score: 0,
    lives,
    level: 1,
    ticks: 0,
    status: 'ready',
    outcome: null,
    paddleDirection: 0,
    rng,
    options: opts,
    config: {
      speed,
      maxSpeed,
      brickValue,
      paddleSpeed: positive(opts.paddleSpeed ?? PADDLE_SPEED, 'paddleSpeed'),
      maxServeAngle: Number(opts.maxServeAngle ?? MAX_SERVE_ANGLE),
    },
  };

  serveBall(state);
  return state;
}

export function serveBall(state) {
  const angle = (state.rng() - 0.5) * 2 * state.config.maxServeAngle;
  const speed = state.config.speed;
  state.ball.x = clampBallX(state, state.paddle.x + state.paddle.width / 2);
  state.ball.y = state.paddle.y - BALL_RADIUS - 1;
  state.ball.vx = Math.sin(angle) * speed;
  state.ball.vy = -Math.cos(angle) * speed;
  state.paddleDirection = 0;
  state.paddle.vx = 0;
  return state;
}

function clampBallX(state, x) {
  const radius = state.ball.radius;
  return Math.min(state.width - radius, Math.max(radius, x));
}

export function clampPaddleX(state, x) {
  return Math.min(state.width - state.paddle.width, Math.max(0, x));
}

export function movePaddle(state, targetX) {
  if (state.status !== 'running' && state.status !== 'ready' && state.status !== 'paused') {
    return state;
  }
  state.paddle.x = clampPaddleX(state, targetX);
  if (state.status === 'ready') {
    state.ball.x = clampBallX(state, state.paddle.x + state.paddle.width / 2);
  }
  return state;
}

export function setPaddleDirection(state, direction) {
  const value = Number(direction) || 0;
  state.paddleDirection = value < 0 ? -1 : value > 0 ? 1 : 0;
  return state;
}

export function stepPaddle(state, dx) {
  return movePaddle(state, state.paddle.x + Number(dx) || 0);
}

export function start(state) {
  if (state.status === 'ready') {
    state.status = 'running';
  }
  return state;
}

export function pause(state) {
  if (state.status === 'running') {
    state.status = 'paused';
  }
  return state;
}

export function resume(state) {
  if (state.status === 'paused') {
    state.status = 'running';
  }
  return state;
}

export function togglePause(state) {
  if (state.status === 'running') {
    return pause(state);
  }
  if (state.status === 'paused') {
    return resume(state);
  }
  return state;
}

export function restart(state) {
  const next = createGame(state.options);
  next.status = 'running';
  return next;
}

export function launch(state) {
  if (state.status === 'ready') {
    state.status = 'running';
  }
  return state;
}

export function bricksAt(state, x, y) {
  return state.bricks.filter((brick) => (
    brick.alive && x >= brick.x && x <= brick.x + brick.width
      && y >= brick.y && y <= brick.y + brick.height
  ));
}

export function isOver(state) {
  return state.status === 'over';
}

function clampSpeed(state) {
  const ball = state.ball;
  const magnitude = Math.hypot(ball.vx, ball.vy);
  const max = state.config.maxSpeed;
  if (magnitude > max && magnitude > 0) {
    const scale = max / magnitude;
    ball.vx *= scale;
    ball.vy *= scale;
  }
}

function hitBrick(state, brick) {
  brick.hits -= 1;
  if (brick.hits <= 0) {
    brick.alive = false;
    state.bricksLeft -= 1;
  }
  state.score += state.config.brickValue;
}

function overlapDepths(ball, brick) {
  const left = (ball.x + ball.radius) - brick.x;
  const right = (brick.x + brick.width) - (ball.x - ball.radius);
  const top = (ball.y + ball.radius) - brick.y;
  const bottom = (brick.y + brick.height) - (ball.y - ball.radius);
  return { left, right, top, bottom };
}

function resolveBrick(state, brick) {
  const ball = state.ball;
  const depths = overlapDepths(ball, brick);
  const minDepthX = Math.min(depths.left, depths.right);
  const minDepthY = Math.min(depths.top, depths.bottom);

  if (minDepthX < minDepthY) {
    if (depths.left < depths.right) {
      ball.x = brick.x - ball.radius;
      ball.vx = -Math.abs(ball.vx);
    } else {
      ball.x = brick.x + brick.width + ball.radius;
      ball.vx = Math.abs(ball.vx);
    }
  } else if (depths.top < depths.bottom) {
    ball.y = brick.y - ball.radius;
    ball.vy = -Math.abs(ball.vy);
  } else {
    ball.y = brick.y + brick.height + ball.radius;
    ball.vy = Math.abs(ball.vy);
  }
  hitBrick(state, brick);
  clampSpeed(state);
}

function stepWalls(state) {
  const ball = state.ball;
  if (ball.x - ball.radius <= 0) {
    ball.x = ball.radius;
    ball.vx = Math.abs(ball.vx);
  } else if (ball.x + ball.radius >= state.width) {
    ball.x = state.width - ball.radius;
    ball.vx = -Math.abs(ball.vx);
  }
  if (ball.y - ball.radius <= 0) {
    ball.y = ball.radius;
    ball.vy = Math.abs(ball.vy);
  }
}

function stepPaddleCollision(state) {
  const ball = state.ball;
  const paddle = state.paddle;
  if (ball.vy <= 0) return;
  if (ball.y + ball.radius < paddle.y) return;
  if (ball.y - ball.radius > paddle.y + paddle.height) return;
  if (ball.x + ball.radius < paddle.x) return;
  if (ball.x - ball.radius > paddle.x + paddle.width) return;

  const centre = paddle.x + paddle.width / 2;
  const offset = Math.max(-1, Math.min(1, (ball.x - centre) / (paddle.width / 2)));
  const speed = Math.hypot(ball.vx, ball.vy) || state.config.speed;
  const angle = offset * state.config.maxServeAngle;
  ball.vx = Math.sin(angle) * speed;
  ball.vy = -Math.abs(Math.cos(angle) * speed);
  ball.y = paddle.y - ball.radius;
  clampSpeed(state);
}

function stepBricks(state) {
  for (const brick of state.bricks) {
    if (!brick.alive) continue;
    const depths = overlapDepths(state.ball, brick);
    if (depths.left > 0 && depths.right > 0 && depths.top > 0 && depths.bottom > 0) {
      resolveBrick(state, brick);
      return;
    }
  }
}

export function loseLife(state) {
  state.lives -= 1;
  if (state.lives <= 0) {
    state.lives = 0;
    state.status = 'over';
    state.outcome = 'lose';
    state.ball.vx = 0;
    state.ball.vy = 0;
    return state;
  }
  serveBall(state);
  return state;
}

function checkWin(state) {
  if (state.bricksLeft <= 0) {
    state.bricksLeft = 0;
    state.status = 'over';
    state.outcome = 'win';
    state.ball.vx = 0;
    state.ball.vy = 0;
    return true;
  }
  return false;
}

export function step(state, dt = FIXED_DT) {
  if (state.status !== 'running') return state;

  const delta = Number.isFinite(dt) && dt > 0 ? dt : FIXED_DT;

  if (state.paddleDirection !== 0) {
    state.paddle.x = clampPaddleX(
      state,
      state.paddle.x + state.paddleDirection * state.config.paddleSpeed * delta,
    );
  }

  const displacement = Math.hypot(state.ball.vx, state.ball.vy) * delta;
  const subSteps = Math.max(1, Math.ceil(displacement / Math.max(1, state.ball.radius)));
  const subDt = delta / subSteps;

  for (let index = 0; index < subSteps; index += 1) {
    state.ball.x += state.ball.vx * subDt;
    state.ball.y += state.ball.vy * subDt;

    stepWalls(state);
    stepBricks(state);
    if (state.status !== 'running') return state;
    stepPaddleCollision(state);
    stepWalls(state);

    if (state.ball.y - state.ball.radius > state.height) {
      loseLife(state);
      return state;
    }
  }

  state.ticks += 1;
  checkWin(state);
  return state;
}

export function run(state, count = 1, dt = FIXED_DT) {
  let current = state;
  for (let index = 0; index < count; index += 1) {
    current = step(current, dt);
    if (current.status !== 'running') break;
  }
  return current;
}

export function simulate(state, count = 1, dt = FIXED_DT) {
  return run(state, count, dt);
}
