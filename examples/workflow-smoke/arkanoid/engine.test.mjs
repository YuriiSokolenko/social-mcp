import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BALL_MAX_SPEED,
  BALL_SPEED,
  BRICK_COLS,
  BRICK_ROWS,
  MAX_SUBSTEP_DISTANCE,
  START_LIVES,
  STATUS_LOST,
  STATUS_PAUSED,
  STATUS_READY,
  STATUS_RUNNING,
  STATUS_WON,
  bricksRemaining,
  createGame,
  layoutBricks,
  launchBall,
  movePaddle,
  movePaddleTo,
  paddleInput,
  resetGame,
  serveBall,
  setPaused,
  startGame,
  step,
  togglePause,
} from './engine.mjs';

const FRAME = 1 / 60;

/** Deterministic world with a 1x1 brick grid so positions stay exact. */
function oneBrick(overrides = {}) {
  const game = createGame({
    width: 640,
    height: 480,
    rows: 1,
    cols: 1,
    brickSideMargin: 0,
    brickGap: 0,
    brickTop: 100,
    brickHeight: 20,
    ballSpeed: 240,
    ...overrides,
  });
  return game;
}

test('initial state is a ready game with full brick wall and three lives', () => {
  const game = createGame();

  assert.equal(game.status, STATUS_READY);
  assert.equal(game.score, 0);
  assert.equal(game.lives, START_LIVES);
  assert.equal(game.level, 1);
  assert.equal(game.bricks.length, BRICK_ROWS * BRICK_COLS);
  assert.equal(bricksRemaining(game), BRICK_ROWS * BRICK_COLS);
  assert.equal(game.bricks.every((brick) => brick.alive), true);

  // Layout is deterministic, so a rebuild matches exactly.
  assert.deepEqual(game.bricks, layoutBricks());

  // The ball starts resting on the paddle, inside the field, not yet launched.
  assert.equal(game.ball.vx, 0);
  assert.equal(game.ball.vy, 0);
  assert.equal(game.ball.x, game.paddle.x);
  assert.ok(game.ball.y > 0 && game.ball.y < game.height);
});

test('left and right wall rebounds reflect vx and keep the ball inside', () => {
  const game = createGame({ rows: 1, cols: 1, brickTop: 900 });
  game.status = STATUS_RUNNING;
  game.ball.x = 12;
  game.ball.vx = -240;
  game.ball.vy = -60;

  step(game, 0.1);

  assert.ok(game.ball.vx > 0, 'vx reflects away from the left wall');
  assert.ok(game.ball.x >= game.ball.radius, 'ball stays inside the left edge');

  game.ball.x = game.width - 12;
  game.ball.vx = 240;

  step(game, 0.1);

  assert.ok(game.ball.vx < 0, 'vx reflects away from the right wall');
  assert.ok(game.ball.x <= game.width - game.ball.radius);
});

test('top wall rebound flips vy downward', () => {
  const game = createGame({ rows: 1, cols: 1, brickTop: 900 });
  game.status = STATUS_RUNNING;
  game.ball.x = 320;
  game.ball.y = 10;
  game.ball.vx = 0;
  game.ball.vy = -240;

  step(game, 0.1);

  assert.ok(game.ball.vy > 0, 'vy flips to travel downward');
  assert.ok(game.ball.y >= game.ball.radius);
  assert.deepEqual(
    game.events.filter((event) => event.type === 'wall').map((event) => event.side),
    ['top'],
  );
});

test('paddle rebound sends the ball upward with an offset-driven angle', () => {
  const game = createGame({ rows: 1, cols: 1, brickTop: 900 });
  game.status = STATUS_RUNNING;
  movePaddleTo(game, 300);

  game.ball.x = 300;
  game.ball.y = game.paddle.y - 1;
  game.ball.vx = 0;
  game.ball.vy = -240; // moving upward, so a hit only lands once it falls back

  // Centre hit: straight up.
  game.ball.y = game.paddle.y - game.ball.radius;
  game.ball.vy = 240;
  step(game, FRAME);

  assert.ok(game.ball.vy < 0, 'the ball leaves the paddle travelling upward');
  assert.equal(game.ball.vx, 0);

  // Right-edge hit: deterministic 60 degree bounce off vertical.
  movePaddleTo(game, 300);
  game.ball.x = 300 + game.paddle.width / 2;
  game.ball.y = game.paddle.y - game.ball.radius;
  game.ball.vy = 240;
  game.ball.vx = 0;

  step(game, FRAME);

  assert.ok(game.ball.vy < 0);
  assert.ok(game.ball.vx > 0, 'hitting the right side throws the ball right');
  assert.ok(
    Math.abs(game.ball.vx) <= BALL_MAX_SPEED,
    'bounce speed stays capped',
  );
});

test('a brick hit scores once, removes the brick, and reflects once', () => {
  const game = oneBrick();
  const brick = game.bricks[0];
  const points = brick.points;

  game.status = STATUS_RUNNING;
  game.ball.x = brick.x + brick.width / 2;
  game.ball.y = brick.y - game.ball.radius + 1;
  game.ball.vx = 0;
  game.ball.vy = 240;

  step(game, FRAME);

  assert.equal(brick.alive, false);
  assert.equal(game.score, points, 'the brick scored exactly once');
  assert.equal(game.bricksDestroyed, 1);
  assert.equal(game.ball.vy < 0, true, 'vy reflected upward off the brick');
  assert.equal(game.ball.vx, 0, 'only the crossed axis reflected');
  assert.equal(
    game.events.filter((event) => event.type === 'brick').length,
    1,
  );

  // A second pass over the same (now dead) brick cannot rescore.
  game.ball.y = brick.y - game.ball.radius + 1;
  game.ball.vy = 240;
  step(game, FRAME);

  assert.equal(game.score, points, 'a removed brick never scores again');
});

test('losing the ball costs a life and serves a new ball', () => {
  const game = oneBrick({ brickTop: 900 });
  game.status = STATUS_RUNNING;
  game.ball.x = 320;
  game.ball.y = 470;
  game.ball.vx = 0;
  game.ball.vy = 240;

  step(game, FRAME);

  assert.equal(game.lives, START_LIVES - 1);
  assert.equal(game.ballsLost, 1);
  assert.equal(game.status, STATUS_READY, 'a new ball is served on the paddle');
  assert.equal(game.ball.vy, 0);
  assert.equal(game.ball.vx, 0);
  assert.equal(game.ball.x, game.paddle.x);
});

test('three missed balls end the game', () => {
  const game = oneBrick({ brickTop: 900 });
  game.status = STATUS_RUNNING;

  for (let i = 0; i < START_LIVES; i += 1) {
    game.status = STATUS_RUNNING;
    game.ball.x = 320;
    game.ball.y = 470;
    game.ball.vx = 0;
    game.ball.vy = 240;
    step(game, FRAME);
  }

  assert.equal(game.lives, 0);
  assert.equal(game.status, STATUS_LOST);

  // Terminal state is sticky: stepping must be a no-op.
  const before = { ...game.ball };
  step(game, FRAME);
  assert.deepEqual({ ...game.ball }, before);
});

test('clearing the last brick wins the level', () => {
  const game = oneBrick();
  const brick = game.bricks[0];

  game.status = STATUS_RUNNING;
  game.ball.x = brick.x + brick.width / 2;
  game.ball.y = brick.y - game.ball.radius + 1;
  game.ball.vx = 0;
  game.ball.vy = 240;

  step(game, FRAME);

  assert.equal(bricksRemaining(game), 0);
  assert.equal(game.status, STATUS_WON);
  assert.ok(game.score > 0);
});

test('resetGame restores the initial layout, score and lives', () => {
  const game = createGame();
  startGame(game);
  game.bricks[0].alive = false;
  game.bricks[1].alive = false;
  game.score = 42;
  game.lives = 1;

  resetGame(game);

  assert.equal(game.score, 0);
  assert.equal(game.lives, START_LIVES);
  assert.equal(game.status, STATUS_READY);
  assert.equal(bricksRemaining(game), BRICK_ROWS * BRICK_COLS);
  assert.deepEqual(game.bricks, layoutBricks());
  assert.equal(game.ball.vx, 0);
  assert.equal(game.ball.vy, 0);
});

test('pause freezes the simulation and resume continues it', () => {
  const game = createGame({ rows: 1, cols: 1, brickTop: 900 });
  startGame(game);
  assert.equal(game.status, STATUS_RUNNING);

  togglePause(game);
  assert.equal(game.status, STATUS_PAUSED);

  const frozen = { ...game.ball };
  step(game, FRAME);
  assert.deepEqual({ ...game.ball }, frozen, 'paused steps do not move the ball');

  // Paused state cannot be started over into running.
  startGame(game);
  assert.equal(game.status, STATUS_PAUSED);

  togglePause(game);
  assert.equal(game.status, STATUS_RUNNING);
  step(game, FRAME);
  assert.notDeepEqual({ ...game.ball }, frozen, 'unpaused steps move the ball');

  setPaused(game, true);
  assert.equal(game.status, STATUS_PAUSED);
  setPaused(game, false);
  assert.equal(game.status, STATUS_RUNNING);
});

test('edge: corner hit reflects one axis and never tunnels the brick', () => {
  const game = oneBrick();
  const brick = game.bricks[0];

  game.status = STATUS_RUNNING;
  // Ball travelling down-right that reaches the brick's left face first: that
  // overlap is shallower, so only vx may reflect.
  game.ball.x = 130;
  game.ball.y = brick.y + 10;
  game.ball.vx = 240;
  game.ball.vy = 240;

  step(game, FRAME);

  assert.equal(brick.alive, false);
  assert.equal(game.score, brick.points, 'corner hit scores exactly once');
  assert.equal(game.ball.vx < 0, true, 'only the horizontal axis reflected');
  assert.equal(game.ball.vy > 0, true, 'the vertical axis was left alone');
});

test('edge: fast balls are substepped so the paddle is never tunneled', () => {
  const game = createGame({ rows: 1, cols: 1, brickTop: 900, ballMaxSpeed: 900 });
  game.status = STATUS_RUNNING;
  movePaddleTo(game, 320);

  const dt = 0.2; // 900 * 0.2 = 180 units, far more than the paddle thickness
  game.ball.x = 320;
  game.ball.y = game.paddle.y - 60;
  game.ball.vx = 0;
  game.ball.vy = 900;

  const distance = 900 * dt;
  const slices = Math.ceil(distance / MAX_SUBSTEP_DISTANCE);
  assert.ok(slices > 1, 'the engine splits a coarse frame');

  step(game, dt);

  assert.ok(game.ball.vy < 0, 'the paddle still caught a fast ball');
  assert.equal(game.lives, START_LIVES, 'no phantom life lost to tunneling');
});

test('edge: ball speed is capped and never goes near-horizontal', () => {
  const game = createGame({ rows: 1, cols: 1, brickTop: 900, ballMaxSpeed: 300 });
  game.status = STATUS_RUNNING;
  game.ball.x = 10;
  game.ball.y = 240;
  game.ball.vx = -10_000;
  game.ball.vy = -1;

  step(game, FRAME);

  const speed = Math.hypot(game.ball.vx, game.ball.vy);
  assert.ok(speed <= 300 + 1e-9, 'speed stays under the configured cap');
  assert.ok(Math.abs(game.ball.vy) >= 1, 'the ball always makes vertical progress');
  assert.equal(game.ball.maxSpeed, 300);
});

test('launch and paddle controls keep their contract', () => {
  const game = createGame({ rows: 1, cols: 1, brickTop: 900 });

  launchBall(game);
  assert.ok(game.ball.vy < 0);
  assert.ok(game.ball.vx > 0);
  assert.ok(Math.abs(Math.hypot(game.ball.vx, game.ball.vy) - BALL_SPEED) < 1e-9);

  serveBall(game);
  assert.equal(game.ball.vx, 0);
  assert.equal(game.ball.vy, 0);
  assert.equal(game.status, STATUS_READY);

  movePaddle(game, -10_000);
  assert.equal(game.paddle.x, game.paddle.width / 2, 'left clamp');
  movePaddle(game, 10_000);
  assert.equal(game.paddle.x, game.width - game.paddle.width / 2, 'right clamp');

  const before = game.paddle.x;
  paddleInput(game, 0, FRAME);
  assert.equal(game.paddle.x, before);
});
