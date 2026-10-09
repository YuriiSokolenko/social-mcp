import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXED_STEP,
  STATUS,
  clampSpeed,
  createGame,
  movePaddle,
  pauseGame,
  resumeGame,
  restartGame,
  serveBall,
  setPaddleTarget,
  startGame,
  stepGame,
} from './engine.mjs';

// Fixture world uses integer-friendly dimensions and speeds so that a small,
// fixed number of steps produces analytically predictable positions.
function makeGame(overrides = {}) {
  return createGame({
    width: 100,
    height: 100,
    ballRadius: 5,
    paddleWidth: 20,
    paddleHeight: 4,
    paddleSpeed: 1000,
    brickColumns: 4,
    brickRows: 2,
    brickWidth: 20,
    brickHeight: 5,
    brickColumnGap: 4,
    brickRowGap: 4,
    brickTop: 20,
    brickLeft: 12,
    launchSpeed: 10,
    bounceSpeed: 10,
    minSpeed: 1,
    maxSpeed: 100,
    brickScore: 7,
    lives: 3,
    ...overrides,
  });
}

function running(overrides) {
  const state = makeGame(overrides);
  startGame(state);
  return state;
}

function place(state, x, y, vx, vy) {
  state.ball.x = x;
  state.ball.y = y;
  state.ball.vx = vx;
  state.ball.vy = vy;
  return state;
}

const brickAt = (state, row, col) => state.bricks.find((brick) => brick.row === row && brick.col === col);

test('initial state is ready with three lives and no score', () => {
  const state = makeGame();

  assert.equal(state.status, STATUS.READY);
  assert.equal(state.score, 0);
  assert.equal(state.lives, 3);
  assert.equal(state.bricks.length, 8);
  assert.ok(state.bricks.every((brick) => brick.alive));

  // A ready ball is parked above the paddle and is not moving.
  assert.equal(state.ball.vx, 0);
  assert.equal(state.ball.vy, 0);
  assert.ok(state.ball.y < state.paddle.y);
});

test('startGame launches the ball and only running states advance', () => {
  const state = makeGame();
  startGame(state);

  assert.equal(state.status, STATUS.RUNNING);
  assert.ok(state.ball.vy < 0);

  const frozen = makeGame();
  const before = { ...frozen.ball };
  stepGame(frozen, 0.5);
  assert.deepEqual({ x: frozen.ball.x, y: frozen.ball.y }, { x: before.x, y: before.y });
});

test('left, right and top walls reflect the ball', () => {
  const state = running();

  // Wall margin is zero, so the ball centre may not pass radius distance.
  place(state, 6, 50, -10, 5);
  stepGame(state, 0.05);
  assert.ok(state.ball.vx > 0, 'left wall reflects vx to positive');
  assert.ok(state.ball.x >= 5, 'ball is clamped inside the left wall');

  place(state, 94, 50, 10, 5);
  stepGame(state, 0.05);
  assert.ok(state.ball.vx < 0, 'right wall reflects vx to negative');
  assert.ok(state.ball.x <= 95, 'ball is clamped inside the right wall');

  place(state, 50, 6, 3, -10);
  stepGame(state, 0.05);
  assert.ok(state.ball.vy > 0, 'top wall reflects vy to positive');
  assert.ok(state.ball.y >= 5);
});

test('paddle bounce sends the ball up and steers vx by offset', () => {
  const state = running();
  state.paddle.x = 40; // paddle spans x 40..60, centre at 50
  state.paddle.y = 96;

  // Hit the left half of the paddle: vx must become negative.
  place(state, 44, 94, -2, 8);
  stepGame(state, 0.02);
  assert.ok(state.ball.vy < 0, 'paddle bounce sends the ball upward');
  assert.ok(state.ball.vx < 0, 'left-of-centre hit steers left');
  assert.ok(state.ball.y <= state.paddle.y, 'no tunneling through the paddle');

  // Hit the right half: vx must become positive.
  place(state, 56, 94, -2, 8);
  stepGame(state, 0.02);
  assert.ok(state.ball.vy < 0);
  assert.ok(state.ball.vx > 0, 'right-of-centre hit steers right');

  // Dead-centre hit keeps the ball vertical.
  place(state, 50, 94, 0, 8);
  stepGame(state, 0.02);
  assert.ok(state.ball.vy < 0);
  assert.ok(Math.abs(state.ball.vx) < 1e-9);
});

test('brick hit removes the brick and scores once', () => {
  const state = running();
  const brick = brickAt(state, 0, 2);
  const centerX = brick.x + brick.width / 2;

  place(state, centerX, brick.y - 5 - 1, 0, 10);
  const steps = 2;
  for (let i = 0; i < steps; i += 1) {
    stepGame(state, FIXED_STEP);
  }

  assert.equal(brick.alive, false);
  assert.equal(state.score, 7);
  assert.ok(state.ball.vy < 0, 'brick hit reflects the ball back upward');

  // A second pass over a dead brick must not score again.
  state.ball.y = brick.y - 5 - 1;
  state.ball.vy = 10;
  for (let i = 0; i < steps; i += 1) {
    stepGame(state, FIXED_STEP);
  }
  assert.equal(state.score, 7);
});

test('losing all bricks wins the game and stops stepping', () => {
  const state = running();
  for (const brick of state.bricks) {
    brick.alive = false;
  }
  place(state, 50, 60, 0, 10);
  stepGame(state, FIXED_STEP);

  assert.equal(state.status, STATUS.WON);
  assert.equal(state.bricks.filter((brick) => brick.alive).length, 0);

  const after = { x: state.ball.x, y: state.ball.y };
  stepGame(state, 0.5);
  assert.equal(state.ball.x, after.x);
  assert.equal(state.ball.y, after.y);
});

test('missing the ball costs exactly one life and triggers a new serve', () => {
  const state = running();
  place(state, 50, 106, 0, 10); // already below the playfield
  const servedY = state.paddle.y - state.ballRadius - 1;

  stepGame(state, FIXED_STEP);

  assert.equal(state.lives, 2);
  assert.equal(state.status, STATUS.RUNNING);
  assert.equal(state.ball.y, servedY);
  assert.equal(state.ball.vx, 0);
  assert.equal(state.ball.vy, 0);
});

test('last life lost ends the game as lost', () => {
  const state = running({ lives: 1 });
  place(state, 50, 106, 0, 10);

  stepGame(state, FIXED_STEP);

  assert.equal(state.lives, 0);
  assert.equal(state.status, STATUS.LOST);
  assert.equal(state.ball.vy, 0);

  stepGame(state, 0.5);
  assert.equal(state.status, STATUS.LOST);
});

test('pause freezes the world and resume continues it', () => {
  const state = running();
  place(state, 50, 60, 6, -8);
  stepGame(state, FIXED_STEP);

  pauseGame(state);
  const frozen = { x: state.ball.x, y: state.ball.y, vx: state.ball.vx, vy: state.ball.vy };
  stepGame(state, 0.25);
  assert.equal(state.status, STATUS.PAUSED);
  assert.deepEqual(
    { x: state.ball.x, y: state.ball.y, vx: state.ball.vx, vy: state.ball.vy },
    frozen,
  );

  resumeGame(state);
  assert.equal(state.status, STATUS.RUNNING);
  stepGame(state, FIXED_STEP);
  assert.notEqual(state.ball.x, frozen.x);
});

test('restart returns a fresh game', () => {
  const state = running();
  state.score = 42;
  state.lives = 1;
  state.bricks[0].alive = false;

  restartGame(state);

  assert.equal(state.status, STATUS.READY);
  assert.equal(state.score, 0);
  assert.equal(state.lives, 3);
  assert.ok(state.bricks.every((brick) => brick.alive));
  assert.equal(state.ball.vx, 0);
  assert.equal(state.ball.vy, 0);
});

test('paddle movement and pointer target stay inside the playfield', () => {
  const state = makeGame();

  movePaddle(state, -1000);
  assert.equal(state.paddle.x, 0);
  movePaddle(state, 5000);
  assert.equal(state.paddle.x, 80);

  setPaddleTarget(state, 25);
  stepGame(state, 0.5);
  assert.ok(state.paddle.x <= 80);
  assert.equal(state.paddle.x, 25);
});

test('speed stays bounded and the ball never gets stuck', () => {
  const state = running({ maxSpeed: 20 });
  place(state, 50, 60, 4, -6);
  state.ball.vy = -600; // far above maxSpeed before clamping

  stepGame(state, 0.1);

  const speed = Math.hypot(state.ball.vx, state.ball.vy);
  assert.ok(speed <= 20, `speed ${speed} stays under maxSpeed`);

  // A long, deterministic run keeps the ball inside the field and moving.
  for (let i = 0; i < 5000; i += 1) {
    stepGame(state, FIXED_STEP);
  }
  assert.ok(state.ball.x >= 0 && state.ball.x <= 100);
  assert.ok(state.ball.y >= 0);
  assert.ok(Math.hypot(state.ball.vx, state.ball.vy) <= 20);
});

test('clampSpeed enforces both bounds without changing direction', () => {
  const ball = { vx: 0, vy: -400, minSpeed: 2, maxSpeed: 50 };
  clampSpeed(ball);
  assert.ok(Math.hypot(ball.vx, ball.vy) <= 50);

  ball.vx = 0.1;
  ball.vy = 0;
  clampSpeed(ball);
  assert.ok(Math.hypot(ball.vx, ball.vy) >= 2);
  assert.equal(ball.vx > 0, true);
});

test('serveBall parks the ball on top of the paddle', () => {
  const state = makeGame();
  state.paddle.x = 10;

  serveBall(state);

  assert.equal(state.ball.x, 10 + 10);
  assert.equal(state.ball.y, state.paddle.y - 5 - 1);
  assert.equal(state.ball.vx, 0);
  assert.equal(state.ball.vy, 0);
});
