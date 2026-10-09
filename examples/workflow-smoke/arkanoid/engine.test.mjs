/* Deterministic physics/rules tests for the Arkanoid engine.
 *
 * Run with: `node --test examples/workflow-smoke/arkanoid/engine.test.mjs`
 * No network, browser, or third-party packages are involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  STATUS,
  ballSpeed,
  bricksRemaining,
  createGame,
  isGameOver,
  isWin,
  paddleTopY,
  pauseGame,
  restartGame,
  resumeGame,
  startGame,
  stepGame,
  togglePause,
} from './engine.mjs';

const INPUT = Object.freeze({ paddleDir: 0 });

// Build a game and then deterministically reposition it. Overrides let a test
// pin the ball, paddle, or a single brick instead of replaying frames.
function mkGame(overrides = {}) {
  const configOverrides = { ...(overrides.config || {}) };
  const state = createGame(configOverrides);
  const { ball, paddle, bricks } = overrides;

  if (paddle) {
    Object.assign(state.paddle, paddle);
  }

  if (bricks) {
    state.bricks = bricks;
  }

  state.status = STATUS.RUNNING;
  if (ball) {
    Object.assign(state.ball, { stuck: false }, ball);
    state.ball.stuck = false;
  }
  return state;
}

function stepN(state, count, input = INPUT) {
  for (let i = 0; i < count; i += 1) {
    stepGame(state, input);
  }
  return state;
}

const ballSpeedCap = () => DEFAULTS.maxBallSpeed;

test('initial state is a ready 3-lifetime game with a full brick grid', () => {
  const state = createGame();

  assert.equal(state.status, STATUS.READY);
  assert.equal(state.score, 0);
  assert.equal(state.lives, 3);
  assert.equal(state.level, 1);
  assert.equal(state.bricks.length, DEFAULTS.brickRows * DEFAULTS.brickCols);
  assert.equal(bricksRemaining(state), DEFAULTS.brickRows * DEFAULTS.brickCols);
  assert.equal(state.ball.stuck, true);
  assert.equal(ballSpeed(state.ball), 0);
  assert.ok(
    state.ball.y < paddleTopY(state),
    'served ball rests above the paddle face'
  );
  assert.ok(state.ball.y > 0 && state.ball.y < state.height);
  assert.equal(state.paddle.x, state.width / 2);
});

test('left and right wall rebounds flip vx and stay inside the arena', () => {
  const left = mkGame({
    ball: { x: DEFAULTS.ballRadius + 0.5, y: 200, vx: -180, vy: -100 },
  });
  stepN(left, 30);
  assert.ok(left.ball.vx > 0, 'left wall reflects vx to positive');
  assert.ok(left.ball.x >= 0);

  const right = mkGame({
    ball: { x: DEFAULTS.width - DEFAULTS.ballRadius - 0.5, y: 200, vx: 180, vy: -100 },
  });
  stepN(right, 30);
  assert.ok(right.ball.vx < 0, 'right wall reflects vx to negative');
  assert.ok(right.ball.x <= DEFAULTS.width);
});

test('top wall rebound flips vy and keeps the ball in bounds', () => {
  const state = mkGame({ ball: { x: 300, y: DEFAULTS.ballRadius + 0.5, vx: 40, vy: -200 } });
  stepN(state, 30);
  assert.ok(state.ball.vy > 0, 'top wall reflects vy downward');
  assert.ok(state.ball.y >= 0 && state.ball.y <= state.height);
});

test('keyboard paddle movement is clamped to the arena', () => {
  const state = createGame();
  startGame(state);
  stepN(state, 400, { paddleDir: -1 });
  assert.equal(state.paddle.x, DEFAULTS.paddleWidth / 2);
  stepN(state, 800, { paddleDir: 1 });
  assert.equal(state.paddle.x, DEFAULTS.width - DEFAULTS.paddleWidth / 2);
  assert.equal(isGameOver(state), false);
});

test('pointer paddle targeting moves the paddle to the requested x', () => {
  const state = createGame();
  startGame(state);
  stepGame(state, { paddleTargetX: 120 });
  assert.equal(state.paddle.x, 120);
  stepGame(state, { paddleTargetX: DEFAULTS.width });
  assert.equal(state.paddle.x, DEFAULTS.width - DEFAULTS.paddleWidth / 2);
});

test('paddle rebound sends the ball upward, biased by the hit offset', () => {
  const state = mkGame({
    paddle: { x: 320 },
    ball: { x: 290, y: 380, vx: 0, vy: 240 },
  });
  stepN(state, 20);

  assert.ok(state.ball.vy < 0, 'ball leaves the paddle upward');
  assert.ok(state.ball.vx < 0, 'hitting left of centre steers the ball left');
  assert.ok(ballSpeed(state.ball) <= ballSpeedCap() + 1e-9);
  assert.ok(state.ball.y < paddleTopY(state), 'ball is pushed clear of the paddle');
});

test('centre paddle hit keeps a vertical rebound', () => {
  const state = mkGame({
    paddle: { x: 320 },
    ball: { x: 320, y: 380, vx: 0, vy: 240 },
  });
  stepN(state, 20);
  assert.ok(state.ball.vy < 0);
  assert.ok(Math.abs(state.ball.vx) < 1e-9, 'centred hit does not steer');
});

test('brick hit removes one brick, scores once, and never double-scores', () => {
  const brick = { x: 260, y: 200, w: 50, h: 22, alive: true };
  const state = mkGame({
    bricks: [brick, { x: 360, y: 100, w: 50, h: 22, alive: true }],
    ball: { x: 285, y: 195, vx: 0, vy: 200 },
  });

  stepN(state, 60);

  assert.equal(brick.alive, false);
  assert.equal(state.score, DEFAULTS.brickPoints);
  assert.equal(bricksRemaining(state), 1);

  // Leaving the brick alone must not re-score it.
  stepN(state, 60);
  assert.equal(state.score, DEFAULTS.brickPoints, 'dead brick cannot score twice');
});

test('brick hit reflects on exactly one axis', () => {
  const brick = { x: 260, y: 200, w: 50, h: 22, alive: true };
  const state = mkGame({
    bricks: [brick],
    ball: { x: 250, y: 210, vx: 220, vy: 20 },
  });
  stepN(state, 40);

  assert.equal(brick.alive, false);
  assert.ok(state.ball.vx < 0, 'side face reflects vx');
  assert.ok(state.ball.vy > 0, 'side face leaves vy untouched (still downward)');
});

test('edge collision on a brick corner resolves on one axis and stays in bounds', () => {
  const brick = { x: 300, y: 200, w: 50, h: 22, alive: true };
  const state = mkGame({
    bricks: [brick],
    ball: { x: 297, y: 225, vx: -60, vy: 200 },
  });
  stepN(state, 40);

  assert.equal(brick.alive, false);
  assert.equal(state.score, DEFAULTS.brickPoints);
  assert.ok(state.ball.y <= state.height, 'ball stays inside the arena');
  assert.ok(state.ball.x >= 0 && state.ball.x <= DEFAULTS.width);
  assert.ok(ballSpeed(state.ball) <= ballSpeedCap() + 1e-9);
});

test('missed ball loses a life and serves a new ball', () => {
  const state = mkGame({
    ball: { x: 320, y: DEFAULTS.height - 2, vx: 0, vy: 240 },
  });
  stepN(state, 10);

  assert.equal(state.lives, 2);
  assert.equal(state.status, STATUS.READY);
  assert.equal(state.ball.stuck, true);
  assert.equal(ballSpeed(state.ball), 0);
  assert.ok(state.ball.y < paddleTopY(state), 'new ball rests on the paddle');
});

test('game over after all lives are lost, then rules stop advancing', () => {
  const state = mkGame({
    ball: { x: 320, y: DEFAULTS.height + 20, vx: 0, vy: 240 },
  });
  state.lives = 1;
  stepN(state, 5);

  assert.equal(state.lives, 0);
  assert.equal(state.status, STATUS.GAMEOVER);
  assert.equal(isGameOver(state), true);

  const scoreAtGameOver = state.score;
  stepN(state, 20);
  assert.equal(state.score, scoreAtGameOver, 'game over is terminal');
});

test('clearing every brick wins the level', () => {
  const bricks = [
    { x: 100, y: 200, w: 50, h: 22, alive: true },
    { x: 160, y: 200, w: 50, h: 22, alive: true },
  ];
  const state = mkGame({ bricks, ball: { x: 125, y: 210, vx: 0, vy: 220 } });
  stepN(state, 40);
  assert.equal(bricks[0].alive, false);

  const last = bricks[1];
  last.x = state.ball.x - 1;
  last.y = state.ball.y - 1;
  stepN(state, 40);

  assert.equal(last.alive, false);
  assert.equal(state.status, STATUS.WON);
  assert.equal(isWin(state), true);
  assert.equal(state.score, 2 * DEFAULTS.brickPoints);

  const scoreAtWin = state.score;
  stepN(state, 30);
  assert.equal(state.score, scoreAtWin, 'won is terminal');
});

test('pause/resume freezes and restores the simulation', () => {
  const state = mkGame({
    ball: { x: 300, y: 200, vx: 120, vy: -160 },
    bricks: [],
  });
  pauseGame(state);
  assert.equal(state.status, STATUS.PAUSED);
  const snapshot = { ...state.ball };
  stepN(state, 30);
  assert.deepEqual(state.ball, snapshot, 'paused steps are no-ops');

  resumeGame(state);
  assert.equal(state.status, STATUS.RUNNING);
  stepN(state, 10);
  assert.notDeepEqual(state.ball, snapshot, 'resumed steps advance');
});

test('togglePause flips running and paused', () => {
  const state = mkGame({ ball: { x: 300, y: 250, vx: 100, vy: -100 }, bricks: [] });
  togglePause(state);
  assert.equal(state.status, STATUS.PAUSED);
  togglePause(state);
  assert.equal(state.status, STATUS.RUNNING);
});

test('restart restores score, lives, brick grid and ready status', () => {
  const state = mkGame({ ball: { x: 300, y: 200, vx: 0, vy: -200 } });
  state.score = 900;
  state.lives = 1;
  state.bricks.forEach((brick, index) => {
    brick.alive = index >= 3;
  });
  state.status = STATUS.RUNNING;

  restartGame(state);

  assert.equal(state.score, 0);
  assert.equal(state.lives, 3);
  assert.equal(state.level, 1);
  assert.equal(state.status, STATUS.READY);
  assert.equal(bricksRemaining(state), DEFAULTS.brickRows * DEFAULTS.brickCols);
  assert.equal(state.paddle.x, DEFAULTS.width / 2);
  assert.equal(state.ball.stuck, true);

  // Restarted state is playable again.
  startGame(state);
  assert.equal(state.status, STATUS.RUNNING);
  assert.ok(ballSpeed(state.ball) > 0);
});

test('startGame launches a stuck ball and launching twice is harmless', () => {
  const state = createGame();
  startGame(state);
  assert.equal(state.status, STATUS.RUNNING);
  assert.equal(state.ball.stuck, false);
  assert.ok(ballSpeed(state.ball) > 0);

  const launched = ballSpeed(state.ball);
  stepN(state, 5, INPUT);
  startGame(state);
  assert.ok(Math.abs(ballSpeed(state.ball) - launched) < 1e-6, 'no re-launch');
});

test('speed stays capped and the ball never tunnels through bricks', () => {
  const state = createGame();
  state.bricks = state.bricks.filter((_b, i) => i !== 0);
  startGame(state);

  for (let i = 0; i < 200; i += 1) {
    stepGame(state, { paddleDir: i % 3 === 0 ? -1 : i % 3 === 1 ? 1 : 0 });
    assert.ok(
      ballSpeed(state.ball) <= ballSpeedCap() + 1e-9,
      `ball speed stayed capped at step ${i}`
    );
    assert.ok(
      state.ball.x >= -1 && state.ball.x <= state.width + 1,
      `ball stayed inside the horizontal arena at step ${i}`
    );
    assert.ok(state.ball.y >= -1);
    if (state.status === STATUS.WON || state.status === STATUS.GAMEOVER) {
      break;
    }
  }

  // A fast ball aimed straight at a brick must destroy it, not pass through.
  const brick = { x: 300, y: 200, w: 50, h: 22, alive: true };
  const fast = mkGame({
    config: { maxBallSpeed: 2000, ballSpeed: 1600 },
    bricks: [brick],
    ball: { x: 325, y: 120, vx: 0, vy: 1600 },
  });
  stepN(fast, 20);
  assert.equal(brick.alive, false, 'fast ball cannot tunnel through a brick');
});
