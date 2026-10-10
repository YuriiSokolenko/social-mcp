// Deterministic engine tests for the pack-20261010-rerun3 Arkanoid mini-game.
// Run: node --test examples/workflow-smoke/pack-20261010-rerun3/arkanoid/engine.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BALL_SPEED,
  BRICK_VALUE,
  FIXED_DT,
  INITIAL_LIVES,
  MAX_BALL_SPEED,
  createGame,
  createRng,
  launch,
  loseLife,
  movePaddle,
  pause,
  restart,
  resume,
  run,
  serveBall,
  start,
  step,
  stepPaddle,
  setPaddleDirection,
} from './engine.mjs';

function bricks(overrides = {}) {
  const list = [];
  for (let index = 0; index < overrides.count; index += 1) {
    list.push({
      id: index,
      row: 0,
      col: index,
      x: (overrides.startX ?? 20) + index * ((overrides.width ?? 20) + (overrides.gap ?? 4)),
      y: overrides.y ?? 40,
      width: overrides.width ?? 20,
      height: overrides.height ?? 16,
      hits: overrides.hits ?? 1,
      alive: true,
    });
  }
  return list;
}

// Small deterministic field; overrides patch the objects the engine created.
function field(overrides = {}) {
  const { bricks: brickSpec, ball, paddle, status, ...rest } = overrides;
  const config = {
    seed: 7,
    width: 200,
    height: 150,
    paddleWidth: 40,
    paddleHeight: 10,
    paddleY: 130,
    ballRadius: 5,
    ballSpeed: 100,
    maxBallSpeed: 200,
    paddleSpeed: 200,
  };
  if (brickSpec) config.bricks = bricks(brickSpec);
  const state = Object.assign(createGame(config), rest);
  if (paddle) Object.assign(state.paddle, paddle);
  if (ball) Object.assign(state.ball, ball);
  state.status = status === undefined ? 'running' : status;
  return state;
}

const centrePaddle = { x: 80, y: 130, width: 40, height: 10, vx: 0 };

test('initial state is a fresh ready game', () => {
  assert.equal(state.bricksTotal, state.bricks.length);
  assert.equal(state.paddle.x, (state.width - state.paddle.width) / 2);
  assert.ok(state.ball.x >= state.ball.radius);
  assert.ok(state.ball.x <= state.width - state.ball.radius);
  assert.ok(state.ball.y >= 0 && state.ball.y <= state.height);

  const ball = (seed) => {
    const g = createGame({ seed });
    return { vx: g.ball.vx, vy: g.ball.vy };
  };
  assert.deepEqual(ball(42), ball(42));
  assert.notDeepEqual(ball(42), ball(43));
});

test('left, right and top walls rebound without losing energy', () => {
  const left = field({ ball: { x: 5.2, y: 70, vx: -100, vy: 40, radius: 5 } });
  step(left);
  assert.ok(left.ball.vx > 0);
  assert.ok(left.ball.x >= left.ball.radius);

  const right = field({ ball: { x: 194.8, y: 70, vx: 100, vy: 40, radius: 5 } });
  step(right);
  assert.ok(right.ball.vx < 0);
  assert.ok(right.ball.x <= right.width - right.ball.radius);

  const top = field({ ball: { x: 100, y: 5.1, vx: 30, vy: -100, radius: 5 } });
  const before = Math.hypot(top.ball.vx, top.ball.vy);
  step(top);
  assert.ok(top.ball.vy > 0);
  assert.ok(top.ball.y >= top.ball.radius);
  assert.ok(Math.abs(Math.hypot(top.ball.vx, top.ball.vy) - before) < 1e-9);
});

test('paddle rebound sends the ball up and steers by contact offset', () => {
  for (const [offsetX, expectedSign] of [[-15, -1], [0, 0], [15, 1]]) {
    const state = field({
      paddle: centrePaddle,
      ball: { x: 100 + offsetX, y: 133, vx: 20, vy: 100, radius: 5 },
    });
    step(state);
    assert.ok(state.ball.vy < 0, `ball ${offsetX} must go up`);
    assert.ok(state.ball.y < state.paddle.y);
    assert.equal(Math.sign(state.ball.vx), expectedSign);
  }
});

test('a brick hit scores once, is removed and reflects the ball', () => {
  const state = field({
    bricks: { count: 1, startX: 90, y: 60, width: 20, height: 16 },
    paddle: centrePaddle,
    ball: { x: 100, y: 78, vx: 0, vy: 100, radius: 5 },
  });
  assert.equal(state.bricksLeft, 1);
  step(state);
  assert.equal(state.score, BRICK_VALUE);
  assert.equal(state.bricks[0].alive, false);
  assert.equal(state.bricksLeft, 0);
  assert.ok(state.ball.vy < 0);
});

test('the same brick cannot score or die twice', () => {
  const state = field({
    bricks: { count: 1, startX: 90, y: 60, width: 20, height: 16 },
    paddle: centrePaddle,
    ball: { x: 100, y: 68, vx: 0, vy: 100, radius: 5 },
  });
  step(state);
  const score = state.score;
  assert.equal(score, BRICK_VALUE);

  // Ball parked inside the (now dead) brick: no further scoring, no re-kill.
  state.ball.vx = 0;
  state.ball.vy = 1;
  state.ball.y = 68;
  run(state, 5);
  assert.equal(state.score, score);
  assert.equal(state.bricks[0].alive, false);
  assert.equal(state.bricksLeft, 0);

  const multi = field({
    bricks: { count: 1, startX: 90, y: 60, width: 20, height: 16, hits: 2 },
    paddle: centrePaddle,
    ball: { x: 100, y: 68, vx: 0, vy: 100, radius: 5 },
  });
  step(multi);
  assert.equal(multi.score, BRICK_VALUE);
  assert.equal(multi.bricks[0].alive, true);
  assert.equal(multi.bricks[0].hits, 1);
  assert.equal(multi.bricksLeft, 1);
});

test('missing the ball costs a life and re-serves without touching the bricks', () => {
  const state = field({
    bricks: { count: 2, startX: 20, y: 40 },
    paddle: centrePaddle,
    ball: { x: 10, y: 152, vx: 100, vy: 100, radius: 5 },
  });
  const score = 30;
  state.score = score;
  const bricksBefore = state.bricks.map((brick) => ({ ...brick }));

  step(state);
  assert.equal(state.lives, INITIAL_LIVES - 1);
  assert.equal(state.status, 'ready');
  assert.equal(state.outcome, null);
  assert.equal(state.score, score);
  assert.deepEqual(state.bricks, bricksBefore);
  assert.ok(state.ball.y < state.paddle.y);
});

test('three misses end the game as a loss and freeze physics', () => {
  const state = field({ status: 'ready' });
  for (let index = 0; index < 3; index += 1) {
    state.status = 'running';
    state.ball.y = state.height + state.ball.radius + 1;
    step(state);
    if (index < 2) assert.equal(state.status, 'ready');
  }
  assert.equal(state.lives, 0);
  assert.equal(state.status, 'over');
  assert.equal(state.outcome, 'lose');
  assert.equal(step(state), state);
});

test('clearing every brick wins with the full brick score', () => {
  const total = 2;
  const state = field({
    bricks: { count: total, startX: 20, y: 40, width: 20, height: 16 },
    paddle: centrePaddle,
    ball: { x: 100, y: 122, vx: 0, vy: -100, radius: 5 },
    status: 'ready',
  });
  start(state);
  let guard = 0;
  while (state.bricksLeft > 0 && guard < 5000) {
    step(state);
    guard += 1;
    if (state.status === 'ready') {
      state.status = 'running';
      state.ball.x = 100;
      state.ball.y = 122;
      state.ball.vx = 0;
      state.ball.vy = -100;
    }
  }
  assert.equal(state.bricksLeft, 0);
  assert.equal(state.status, 'over');
  assert.equal(state.outcome, 'win');
  assert.equal(state.score, total * BRICK_VALUE);
  assert.equal(step(state), state);
});

test('pause freezes physics, resume restores it, restart rebuilds, start on over is identity', () => {
  const state = field({
    ball: { x: 100, y: 100, vx: 60, vy: 80, radius: 5 },
    status: 'ready',
  });
  start(state);
  assert.equal(state.status, 'running');
  run(state, 5);
  const ticks = state.ticks;
  const y = Math.round(state.ball.y * 1000) / 1000;

  pause(state);
  assert.equal(state.status, 'paused');
  assert.equal(step(state), state);
  assert.equal(state.ticks, ticks);
  assert.equal(Math.round(state.ball.y * 1000) / 1000, y);

  resume(state);
  assert.equal(state.status, 'running');
  run(state, 3);
  assert.ok(state.ticks > ticks);

  const fresh = field({
    bricks: { count: 3, startX: 20, y: 40 },
    paddle: { x: 0, y: 130, width: 40, height: 10, vx: 0 },
    ball: { x: 190, y: 100, vx: 100, vy: 100, radius: 5 },
  });
  run(fresh, 4000);
  assert.equal(fresh.status, 'over');
  assert.equal(fresh.outcome, 'lose');
  assert.equal(fresh.lives, 0);
  fresh.lives = 1;
  const next = restart(fresh);
  assert.equal(next.lives, INITIAL_LIVES);
  assert.equal(next.score, 0);
  assert.equal(next.ticks, 0);
  assert.equal(next.bricksLeft, next.bricksTotal);
  assert.equal(next.status, 'running');

  const over = field({ status: 'over' });
  over.outcome = 'win';
  assert.equal(start(over), over);
  assert.equal(over.status, 'over');
});

test('edge collisions: corner contact and a brick flush against a side wall', () => {
  // Corner: ball arriving at the bottom-left corner leaves on the x axis.
  const corner = field({
    bricks: { count: 1, startX: 90, y: 60, width: 20, height: 16 },
    paddle: { x: 80, y: 130, width: 40, height: 10, vx: 0 },
    ball: { x: 88, y: 78, vx: -100, vy: 100, radius: 5 },
  });
  step(corner);
  assert.equal(corner.bricks[0].alive, false);
  assert.equal(corner.score, BRICK_VALUE);
  assert.ok(Number.isFinite(corner.ball.x) && Number.isFinite(corner.ball.vy));
  assert.ok(corner.ball.x <= 90 - corner.ball.radius + 1e-9);

  // Flush against the left wall: ball must not tunnel through the brick row.
  const wall = field({
    bricks: { count: 1, startX: 0, y: 60, width: 20, height: 16 },
    paddle: { x: 80, y: 130, width: 40, height: 10, vx: 0 },
    ball: { x: 5, y: 78, vx: 0, vy: 100, radius: 5 },
  });
  step(wall);
  assert.equal(wall.bricks[0].alive, false);
  assert.ok(wall.ball.y >= 60 + 16 + wall.ball.radius - 1e-9);
  assert.ok(wall.ball.x >= wall.ball.radius && wall.ball.x <= wall.width - wall.ball.radius);
});

test('simulation is deterministic, speed-capped and in bounds', () => {
  const build = () => start(createGame({ seed: 99 }));
  const snapshot = (game) => ({
    ball: { x: game.ball.x, y: game.ball.y, vx: game.ball.vx, vy: game.ball.vy },
    paddleX: game.paddle.x,
    score: game.score,
    lives: game.lives,
    bricksLeft: game.bricksLeft,
    status: game.status,
    outcome: game.outcome,
  });
  const runSeed = () => snapshot(run(start(createGame({ seed: 99 })), 600));
  assert.deepEqual(runSeed(), runSeed());

  const state = start(createGame({ seed: 99 }));
  let maxMagnitude = 0;
  for (let index = 0; index < 600; index += 1) {
    step(state);
    const magnitude = Math.hypot(state.ball.vx, state.ball.vy);
    maxMagnitude = Math.max(maxMagnitude, magnitude);
    assert.ok(state.ball.x >= state.ball.radius - 1e-9);
    assert.ok(state.ball.x <= state.width - state.ball.radius + 1e-9);
    assert.ok(Number.isFinite(state.ball.y));
    if (state.status !== 'running') break;
  }
  assert.ok(maxMagnitude > 0);
  assert.ok(maxMagnitude <= MAX_BALL_SPEED + 1e-9);
  const served = createGame({ seed: 5 });
  assert.ok(Math.abs(Math.hypot(served.ball.vx, served.ball.vy) - BALL_SPEED) < 1e-9);
});

test('paddle controls clamp inside the field, and degenerate fields are rejected', () => {
  const state = field({ status: 'running' });
  movePaddle(state, -500);
  assert.equal(state.paddle.x, 0);
  movePaddle(state, 100000);
  assert.equal(state.paddle.x, state.width - state.paddle.width);
  setPaddleDirection(state, -1);
  run(state, 3);
  assert.equal(state.paddle.x, 0);
  setPaddleDirection(state, 1);
  run(state, 3);
  assert.ok(state.paddle.x > 0);
  stepPaddle(state, 100000);
  assert.equal(state.paddle.x, state.width - state.paddle.width);

  assert.throws(() => createGame({ width: 2 }), RangeError);
  assert.throws(() => createGame({ height: 0 }), RangeError);
  assert.throws(() => createGame({ paddleWidth: 10000 }), RangeError);
});

test('serve and launch are reproducible helpers', () => {
  const snapshot = (game) => ({
    x: game.ball.x,
    y: game.ball.y,
    vx: game.ball.vx,
    vy: game.ball.vy,
  });
  const first = snapshot(createGame({ seed: 8 }));
  assert.deepEqual(snapshot(serveBall(createGame({ seed: 8 }))), first);
  assert.equal(createRng(8)(), createRng(8)());

  const served = createGame({ seed: 8 });
  assert.equal(launch(served), served);
  assert.equal(served.status, 'running');
});
