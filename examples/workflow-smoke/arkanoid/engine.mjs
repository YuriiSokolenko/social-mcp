// Pure, deterministic Arkanoid/Breakout rules.
//
// This module is intentionally free of DOM, Canvas, timers, randomness and
// network access so it can be imported by both the browser client and the
// Node test runner without stubs.

export const WORLD_WIDTH = 640;
export const WORLD_HEIGHT = 480;

export const PADDLE_WIDTH = 96;
export const PADDLE_HEIGHT = 16;
export const PADDLE_SPEED = 480;

export const BALL_RADIUS = 8;
export const BALL_SPEED = 240;
export const BALL_MAX_SPEED = 420;

export const BRICK_ROWS = 5;
export const BRICK_COLS = 8;
export const BRICK_TOP = 64;
export const BRICK_SIDE_MARGIN = 16;
export const BRICK_GAP = 6;
export const BRICK_HEIGHT = 22;

export const START_LIVES = 3;
export const MAX_LIVES = 3;

export const MAX_SUBSTEP_DISTANCE = 2;

export const STATUS_READY = 'ready';
export const STATUS_RUNNING = 'running';
export const STATUS_PAUSED = 'paused';
export const STATUS_WON = 'won';
export const STATUS_LOST = 'lost';

const TERMINAL_STATUSES = [STATUS_WON, STATUS_LOST];

/** Upper bound on the bounce angle away from vertical, in radians. */
const MAX_BOUNCE_ANGLE = Math.PI / 3;
/** Fraction of the ball speed that must stay vertical after a bounce. */
const MIN_VERTICAL_FACTOR = 0.25;

export function clamp(value, low, high) {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

/** Fixed row/column brick grid: no randomisation, so layouts are stable. */
export function layoutBricks(config = {}) {
  const width = config.width ?? WORLD_WIDTH;
  const rows = config.rows ?? BRICK_ROWS;
  const cols = config.cols ?? BRICK_COLS;
  const top = config.brickTop ?? BRICK_TOP;
  const sideMargin = config.brickSideMargin ?? BRICK_SIDE_MARGIN;
  const gap = config.brickGap ?? BRICK_GAP;
  const brickHeight = config.brickHeight ?? BRICK_HEIGHT;

  const brickWidth = (width - 2 * sideMargin - (cols - 1) * gap) / cols;
  const bricks = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      bricks.push({
        id: row * cols + col,
        row,
        col,
        x: sideMargin + col * (brickWidth + gap),
        y: top + row * (brickHeight + gap),
        width: brickWidth,
        height: brickHeight,
        points: rows - row,
        alive: true,
      });
    }
  }

  return bricks;
}

export function createWorld(config = {}) {
  const width = config.width ?? WORLD_WIDTH;
  const height = config.height ?? WORLD_HEIGHT;
  const paddleWidth = config.paddleWidth ?? PADDLE_WIDTH;
  const paddleHeight = config.paddleHeight ?? PADDLE_HEIGHT;
  const ballRadius = config.ballRadius ?? BALL_RADIUS;

  return {
    width,
    height,
    paddle: {
      width: paddleWidth,
      height: paddleHeight,
      x: width / 2,
      y: height - paddleHeight,
      speed: config.paddleSpeed ?? PADDLE_SPEED,
    },
    ball: {
      radius: ballRadius,
      x: width / 2,
      y: height - paddleHeight - ballRadius - 1,
      vx: 0,
      vy: 0,
      speed: config.ballSpeed ?? BALL_SPEED,
      maxSpeed: config.ballMaxSpeed ?? BALL_MAX_SPEED,
    },
    bricks: layoutBricks(config),
  };
}

export function createGame(config = {}) {
  const world = createWorld(config);
  const lives = config.lives ?? START_LIVES;

  return {
    width: world.width,
    height: world.height,
    paddle: world.paddle,
    ball: world.ball,
    bricks: world.bricks,
    score: 0,
    lives,
    maxLives: MAX_LIVES,
    level: 1,
    status: STATUS_READY,
    ballsLost: 0,
    bricksDestroyed: 0,
    events: [],
  };
}

export function bricksRemaining(game) {
  let remaining = 0;
  for (const brick of game.bricks) {
    if (brick.alive) remaining += 1;
  }
  return remaining;
}

export function isTerminal(game) {
  return TERMINAL_STATUSES.includes(game.status);
}

export function isRunning(game) {
  return game.status === STATUS_RUNNING;
}

/** Put a fresh ball on the paddle and go back to the `ready` state. */
export function serveBall(game) {
  game.ball.x = game.paddle.x;
  game.ball.y = game.paddle.y - game.ball.radius - 1;
  game.ball.vx = 0;
  game.ball.vy = 0;
  if (!isTerminal(game)) game.status = STATUS_READY;
  return game;
}

export function launchBall(game) {
  if (isTerminal(game)) return game;

  const angle = -Math.PI / 4; // up and to the right, deterministic
  const speed = clamp(game.ball.speed, 1, game.ball.maxSpeed);
  game.ball.speed = speed;
  game.ball.vx = Math.cos(angle) * speed;
  game.ball.vy = Math.sin(angle) * speed;
  return game;
}

function hasVelocity(ball) {
  return ball.vx !== 0 || ball.vy !== 0;
}

/**
 * Apply a keyboard paddle direction in [-1, 0, 1] over `dt` seconds and keep a
 * ready ball glued to the paddle so the serve position follows the player.
 */
export function paddleInput(game, direction, dt) {
  if (isTerminal(game) || game.status === STATUS_PAUSED) return game;

  if (direction !== 0) {
    movePaddle(game, direction * game.paddle.speed * dt);
  }
  if (game.status === STATUS_READY) {
    game.ball.x = game.paddle.x;
    game.ball.y = game.paddle.y - game.ball.radius - 1;
  }
  return game;
}

export function startGame(game) {
  if (isTerminal(game)) return game;

  if (game.status === STATUS_READY || !hasVelocity(game.ball)) {
    launchBall(game);
  }
  game.status = STATUS_RUNNING;
  return game;
}

export function setPaused(game, paused) {
  if (isTerminal(game)) return game;
  if (paused) {
    if (game.status === STATUS_RUNNING || game.status === STATUS_READY) {
      game.status = STATUS_PAUSED;
    }
  } else if (game.status === STATUS_PAUSED) {
    game.status = STATUS_RUNNING;
  }
  return game;
}

export function togglePause(game) {
  if (game.status === STATUS_PAUSED) return setPaused(game, false);
  return setPaused(game, true);
}

export function resetGame(game) {
  const world = createWorld({
    width: game.width,
    height: game.height,
    paddleWidth: game.paddle.width,
    paddleHeight: game.paddle.height,
    paddleSpeed: game.paddle.speed,
    ballRadius: game.ball.radius,
    ballSpeed: BALL_SPEED,
    ballMaxSpeed: game.ball.maxSpeed,
  });

  game.paddle = world.paddle;
  game.ball = world.ball;
  game.bricks = world.bricks;
  game.score = 0;
  game.lives = game.maxLives;
  game.level = 1;
  game.status = STATUS_READY;
  game.ballsLost = 0;
  game.bricksDestroyed = 0;
  game.events = [];
  return game;
}

function speedOf(ball) {
  return Math.hypot(ball.vx, ball.vy);
}

function normalizeSpeed(ball, targetSpeed) {
  const current = speedOf(ball);
  if (current === 0) return;
  const speed = clamp(targetSpeed, 1, ball.maxSpeed);
  let vx = (ball.vx / current) * speed;
  let vy = (ball.vy / current) * speed;

  // Keep some vertical speed so the ball never travels near-horizontally.
  const minVertical = Math.max(1, ball.maxSpeed * MIN_VERTICAL_FACTOR);
  if (Math.abs(vy) < minVertical) {
    vy = Math.sign(vy || 1) * minVertical;
    vx = Math.sign(vx || 1) * Math.sqrt(Math.max(0, speed * speed - vy * vy));
  }

  ball.vx = vx;
  ball.vy = vy;
  ball.speed = speed;
}

function pushEvent(game, event) {
  if (!Array.isArray(game.events)) game.events = [];
  game.events.push(event);
}

function collideWall(game) {
  const { ball } = game;
  let hit = false;

  if (ball.x - ball.radius <= 0 && ball.vx < 0) {
    ball.x = ball.radius;
    ball.vx = -ball.vx;
    hit = true;
    pushEvent(game, { type: 'wall', side: 'left' });
  } else if (ball.x + ball.radius >= game.width && ball.vx > 0) {
    ball.x = game.width - ball.radius;
    ball.vx = -ball.vx;
    hit = true;
    pushEvent(game, { type: 'wall', side: 'right' });
  }

  if (ball.y - ball.radius <= 0 && ball.vy < 0) {
    ball.y = ball.radius;
    ball.vy = -ball.vy;
    hit = true;
    pushEvent(game, { type: 'wall', side: 'top' });
  }

  return hit;
}

function collidePaddle(game) {
  const { ball, paddle } = game;
  if (ball.vy <= 0) return false;

  const left = paddle.x - paddle.width / 2;
  const right = paddle.x + paddle.width / 2;
  if (ball.y + ball.radius < paddle.y) return false;
  if (ball.y - ball.radius > paddle.y + paddle.height) return false;
  if (ball.x + ball.radius < left || ball.x - ball.radius > right) return false;

  ball.y = paddle.y - ball.radius;

  // Hit offset across the paddle maps to a bounded bounce angle.
  const offset = clamp((ball.x - paddle.x) / (paddle.width / 2), -1, 1);
  const angle = offset * MAX_BOUNCE_ANGLE;
  const speed = clamp(speedOf(ball), ball.speed, ball.maxSpeed);
  ball.speed = speed;
  ball.vx = Math.sin(angle) * speed;
  ball.vy = -Math.abs(Math.cos(angle) * speed);
  pushEvent(game, { type: 'paddle', offset });
  return true;
}

function collideBrick(game) {
  const { ball } = game;

  for (const brick of game.bricks) {
    if (!brick.alive) continue;

    if (
      ball.x + ball.radius < brick.x ||
      ball.x - ball.radius > brick.x + brick.width ||
      ball.y + ball.radius < brick.y ||
      ball.y - ball.radius > brick.y + brick.height
    ) {
      continue;
    }

    // Penetration depth per face: the shallowest crossed axis is the one the
    // ball actually entered through, so a corner hit reflects one axis only.
    const fromLeft = brick.x - (ball.x - ball.radius);
    const fromRight = ball.x + ball.radius - (brick.x + brick.width);
    const fromTop = brick.y - (ball.y - ball.radius);
    const fromBottom = ball.y + ball.radius - brick.y;
    const px = Math.min(fromLeft, fromRight);
    const py = Math.min(fromTop, fromBottom);

    if (py >= px) {
      if (fromTop >= fromBottom) {
        ball.y = brick.y - ball.radius;
        if (ball.vy > 0) ball.vy = -ball.vy;
      } else {
        ball.y = brick.y + brick.height + ball.radius;
        if (ball.vy < 0) ball.vy = -ball.vy;
      }
    } else if (fromLeft >= fromRight) {
      ball.x = brick.x - ball.radius;
      if (ball.vx > 0) ball.vx = -ball.vx;
    } else {
      ball.x = brick.x + brick.width + ball.radius;
      if (ball.vx < 0) ball.vx = -ball.vx;
    }

    brick.alive = false;
    game.bricksDestroyed += 1;
    game.score += brick.points;
    normalizeSpeed(ball, speedOf(ball));
    pushEvent(game, { type: 'brick', id: brick.id, points: brick.points });
    return true;
  }

  return false;
}

function loseLife(game) {
  game.ballsLost += 1;
  game.lives -= 1;
  pushEvent(game, { type: 'life', lives: game.lives });

  if (game.lives <= 0) {
    game.lives = 0;
    game.status = STATUS_LOST;
    return;
  }

  serveBall(game);
}

function checkWin(game) {
  if (bricksRemaining(game) === 0) {
    game.status = STATUS_WON;
    return true;
  }
  return false;
}

/** One un-subdivided integration slice. */
function stepBall(game, dt) {
  const { ball } = game;

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  if (ball.y - ball.radius > game.height) {
    loseLife(game);
    return;
  }

  collideWall(game);
  collidePaddle(game);
  collideBrick(game);
  checkWin(game);
}

/**
 * Advance the simulation by `dt` seconds. The step is subdivided so a fast ball
 * can never tunnel through the paddle or a brick at coarse frame steps.
 */
export function step(game, dt) {
  if (game.status !== STATUS_RUNNING || dt <= 0) return game;

  game.events = [];

  const distance = speedOf(game.ball) * dt;
  const slices = Math.max(1, Math.ceil(distance / MAX_SUBSTEP_DISTANCE));
  const slice = dt / slices;

  for (let i = 0; i < slices; i += 1) {
    stepBall(game, slice);
    if (game.status !== STATUS_RUNNING) break;
  }

  return game;
}