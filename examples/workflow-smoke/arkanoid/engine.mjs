// Pure, deterministic Arkanoid/Breakout rules and physics.
//
// This module must stay free of any browser/Node host API: no `window`,
// `document`, `requestAnimationFrame`, `performance.now`, `Date.now` or
// `Math.random`. The same input sequence must always produce the same state
// sequence so `engine.test.mjs` can unit-test physics under plain `node --test`.

export const DEFAULTS = Object.freeze({
  width: 640,
  height: 480,
  paddleWidth: 96,
  paddleHeight: 16,
  paddleBottomGap: 28,
  paddleSpeed: 420,
  ballRadius: 8,
  ballSpeed: 260,
  maxBallSpeed: 340,
  brickRows: 5,
  brickCols: 10,
  brickTop: 70,
  brickSideMargin: 20,
  brickGap: 6,
  brickHeight: 22,
  brickPoints: 100,
  maxBounceAngle: Math.PI / 3,
  lives: 3,
  // Fixed timestep. The host (main.mjs) owns the accumulator; the engine only
  // ever sees exactly one `dt` per `stepGame` call.
  dt: 1 / 120,
});

export const STATUS = Object.freeze({
  READY: 'ready',
  RUNNING: 'running',
  PAUSED: 'paused',
  WON: 'won',
  GAMEOVER: 'gameover',
});


export function createConfig(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

function normalizeSpeed(ball, config) {
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed <= 0) {
    return;
  }
  const target = Math.min(speed, config.maxBallSpeed);
  const scale = target / speed;
  ball.vx *= scale;
  ball.vy *= scale;
}

function buildBricks(config) {
  const usableWidth = config.width - config.brickSideMargin * 2;
  const brickWidth =
    (usableWidth - config.brickGap * (config.brickCols - 1)) / config.brickCols;
  const bricks = [];
  for (let row = 0; row < config.brickRows; row += 1) {
    for (let col = 0; col < config.brickCols; col += 1) {
      bricks.push({
        x: config.brickSideMargin + col * (brickWidth + config.brickGap),
        y: config.brickTop + row * (config.brickHeight + config.brickGap),
        w: brickWidth,
        h: config.brickHeight,
        alive: true,
      });
    }
  }
  return bricks;
}

function makeBall(config) {
  return {
    x: config.width / 2,
    y: config.height - config.paddleBottomGap - config.paddleHeight - config.ballRadius - 1,
    vx: 0,
    // Serves are upward-ish so the ball always leaves the play area upwards.
    vy: 0,
    r: config.ballRadius,
    stuck: true,
    hitPaddle: false,
  };
}

function makePaddle(config) {
  return {
    x: config.width / 2,
    width: config.paddleWidth,
    height: config.paddleHeight,
  };
}

export function paddleTopY(state) {
  return state.height - state.config.paddleBottomGap - state.paddle.height;
}

export function ballSpeed(ball) {
  return Math.hypot(ball.vx, ball.vy);
}

export function createGame(configOverrides = {}) {
  const config = createConfig(configOverrides);
  const state = {
    config,
    width: config.width,
    height: config.height,
    status: STATUS.READY,
    score: 0,
    lives: config.lives,
    level: 1,
    elapsed: 0,
    paddle: makePaddle(config),
    ball: makeBall(config),
    bricks: buildBricks(config),
  };
  resetBall(state);
  return state;
}

// Fresh ball resting on the paddle, waiting for `launchGame`.
export function serveBall(state) {
  const config = state.config;
  const ball = makeBall(config);
  state.ball = ball;
  attachBallToPaddle(state);
}

function attachBallToPaddle(state) {
  const ball = state.ball;
  ball.x = state.paddle.x;
  ball.y = paddleTopY(state) - ball.r - 1;
  ball.vx = 0;
  ball.vy = 0;
  ball.stuck = true;
  ball.hitPaddle = false;
}

function movePaddle(state, input) {
  const { config } = state;
  const paddle = state.paddle;
  const half = paddle.width / 2;
  if (typeof input.paddleTargetX === 'number' && Number.isFinite(input.paddleTargetX)) {
    paddle.x = clamp(input.paddleTargetX, half, config.width - half);
    return;
  }
  const dir = input.paddleDir || 0;
  if (dir !== 0) {
    paddle.x = clamp(
      paddle.x + dir * config.paddleSpeed * config.dt,
      half,
      config.width - half
    );
  }
}

function launchBall(state) {
  const { config } = state;
  const ball = state.ball;
  ball.stuck = false;
  ball.hitPaddle = false;
  // Fixed, deterministic serve angle (no randomness): up and slightly right.
  const angle = Math.PI / 6;
  ball.vx = config.ballSpeed * Math.sin(angle);
  ball.vy = -config.ballSpeed * Math.cos(angle);
  normalizeSpeed(ball, config);
}

export function startGame(state) {
  if (state.status === STATUS.READY) {
    launchBall(state);
    state.status = STATUS.RUNNING;
  }
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

export function togglePause(state) {
  if (state.status === STATUS.PAUSED) {
    return resumeGame(state);
  }
  return pauseGame(state);
}

export function restartGame(state) {
  const { config } = state;
  state.status = STATUS.READY;
  state.score = 0;
  state.lives = config.lives;
  state.level = 1;
  state.elapsed = 0;
  state.paddle = makePaddle(config);
  state.bricks = buildBricks(config);
  serveBall(state);
  return state;
}

function loseLife(state) {
  state.lives -= 1;
  if (state.lives <= 0) {
    state.lives = 0;
    state.status = STATUS.GAMEOVER;
    state.ball.stuck = true;
    state.ball.vx = 0;
    state.ball.vy = 0;
    return;
  }
  state.status = STATUS.READY;
  serveBall(state);
}

function stepBallSubstep(state, dt) {
  const { config } = state;
  const ball = state.ball;
  const paddle = state.paddle;

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  // Walls: left / right / top. The bottom is intentionally open (miss).
  if (ball.x - ball.r <= 0 && ball.vx < 0) {
    ball.x = ball.r;
    ball.vx = -ball.vx;
    normalizeSpeed(ball, config);
  } else if (ball.x + ball.r >= config.width && ball.vx > 0) {
    ball.x = config.width - ball.r;
    ball.vx = -ball.vx;
    normalizeSpeed(ball, config);
  }
  if (ball.y - ball.r <= 0 && ball.vy < 0) {
    ball.y = ball.r;
    ball.vy = -ball.vy;
    normalizeSpeed(ball, config);
  }

  // Paddle plane crossing. `hitPaddle` is latched until the ball leaves the
  // paddle band again so one crossing can never produce two bounces.
  const topY = paddleTopY(state);
  const inBand = ball.y + ball.r >= topY && ball.y - ball.r <= topY + paddle.height;
  if (!inBand) {
    ball.hitPaddle = false;
  }
  if (
    !ball.hitPaddle &&
    ball.vy > 0 &&
    ball.y + ball.r >= topY &&
    ball.y - ball.r <= topY + paddle.height
  ) {
    const half = paddle.width / 2;
    const offset = clamp((ball.x - paddle.x) / half, -1, 1);
    ball.y = topY - ball.r;
    const angle = offset * (config.maxBounceAngle / 2);
    let speed = ballSpeed(ball);
    if (speed <= 0) {
      speed = config.ballSpeed;
    }
    ball.vx = speed * Math.sin(angle);
    ball.vy = -speed * Math.cos(angle);
    ball.hitPaddle = true;
    normalizeSpeed(ball, config);
  }

  // Bricks: resolve the first overlapping brick on the smaller overlap axis.
  const bricks = state.bricks;
  for (let i = 0; i < bricks.length; i += 1) {
    const brick = bricks[i];
    if (!brick.alive) {
      continue;
    }
    const closestX = clamp(ball.x, brick.x, brick.x + brick.w);
    const closestY = clamp(ball.y, brick.y, brick.y + brick.h);
    const dx = ball.x - closestX;
    const dy = ball.y - closestY;
    if (dx * dx + dy * dy > ball.r * ball.r) {
      continue;
    }
    const overlapLeft = ball.x + ball.r - brick.x;
    const overlapRight = brick.x + brick.w - (ball.x - ball.r);
    const overlapTop = ball.y + ball.r - brick.y;
    const overlapBottom = brick.y + brick.h - (ball.y - ball.r);
    const overlapX = Math.min(overlapLeft, overlapRight);
    const overlapY = Math.min(overlapTop, overlapBottom);
    if (overlapX < overlapY) {
      // Horizontal face: reflect on X only, never both axes.
      ball.vx = overlapLeft < overlapRight ? -Math.abs(ball.vx) : Math.abs(ball.vx);
    } else {
      ball.vy = overlapTop < overlapBottom ? -Math.abs(ball.vy) : Math.abs(ball.vy);
    }
    brick.alive = false;
    state.score += config.brickPoints;
    normalizeSpeed(ball, config);
    // One brick per sub-step: no double scoring / double removal.
    break;
  }

  if (ball.y - ball.r > config.height) {
    loseLife(state);
    return false;
  }
  return true;
}

function stepLive(state, input) {
  const { config } = state;
  movePaddle(state, input);

  const ball = state.ball;
  if (ball.stuck) {
    attachBallToPaddle(state);
  } else {
    // Anti-tunnelling: never move more than a fraction of the ball radius in
    // one sub-step, so reasonable frame steps cannot pass through bricks or
    // the paddle.
    const speed = Math.hypot(ball.vx, ball.vy);
    let subSteps = 1;
    if (speed > 0) {
      subSteps = Math.max(1, Math.ceil((speed * config.dt) / (ball.r * 0.5)));
    }
    const maxSubSteps = 64;
    if (subSteps > maxSubSteps) {
      subSteps = maxSubSteps;
    }
    const subDt = config.dt / subSteps;
    for (let i = 0; i < subSteps; i += 1) {
      if (!stepBallSubstep(state, subDt)) {
        break;
      }
      if (state.bricks.every((b) => b.alive === false)) {
        break;
      }
    }
  }

  if (state.bricks.every((b) => b.alive === false)) {
    state.status = STATUS.WON;
  }
  state.elapsed += config.dt;
  return state;
}

// Advances the simulation by exactly one fixed `config.dt`.
// `input` may carry `{ paddleDir: -1 | 0 | 1 }` (keyboard) or
// `{ paddleTargetX: number }` (pointer/touch). Returns the same state object.
export function stepGame(state, input = {}) {
  if (state.status !== STATUS.RUNNING && state.status !== STATUS.READY) {
    // paused / won / gameover are terminal or idle: rules do not advance.
    return state;
  }
  return stepLive(state, input);
}

export function isWin(state) {
  return state.status === STATUS.WON;
}

export function isGameOver(state) {
  return state.status === STATUS.GAMEOVER;
}

export function bricksRemaining(state) {
  return state.bricks.filter((b) => b.alive).length;
}

export { ballSpeed };
