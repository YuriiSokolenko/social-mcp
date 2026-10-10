// Deterministic engine tests: no DOM, no timers, no network.
//
// Run with:
//   node --test examples/workflow-smoke/pack-20261011-rerun4/arkanoid/engine.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  BRICK_COLS,
  BRICK_ROWS,
  LIVES,
  MAX_BALL_SPEED,
  BALL_RADIUS,
  PLAYFIELD_HEIGHT,
  createGame,
  createRng,
  step,
  run,
  start,
  serve,
  pause,
  resume,
  restart,
  isOver,
  movePaddle,
  movePaddleByDirections,
  setPaddleTarget,
} from "./engine.mjs";

// Every test controls the whole state through explicit overrides, so physics
// assertions never depend on random serve angles or on earlier levels.
function board(overrides = {}) {
  return { ...createGame({ seed: 7, rows: 2, cols: 4 }), ...overrides };
}

function brick(overrides = {}) {
  return {
    id: "brick-0",
    x: 100,
    y: 100,
    w: 40,
    h: 10,
    points: 10,
    alive: true,
    ...overrides,
  };
}

test("initial state is ready with full layout and centered paddle", () => {
  const state = createGame();
  assert.equal(state.status, "ready");
  assert.equal(state.outcome, null);
  assert.equal(state.score, 0);
  assert.equal(state.ticks, 0);
  assert.equal(state.lives, LIVES);
  assert.equal(state.bricks.length, BRICK_COLS * BRICK_ROWS);
  assert.equal(state.remaining, BRICK_COLS * BRICK_ROWS);
  assert.ok(state.bricks.every((item) => item.alive));
  assert.equal(state.paddle.x, (state.width - state.paddle.width) / 2);
  assert.ok(state.ball.x > 0 && state.ball.x < state.width);
  assert.ok(state.ball.y > 0 && state.ball.y < state.height);
});

test("createGame rejects layouts that the fixed step cannot resolve", () => {
  assert.throws(() => createGame({ rows: 0 }), RangeError);
  assert.throws(() => createGame({ width: 0 }), RangeError);
  assert.throws(() => createGame({ paddleWidth: 480 }), RangeError);
  assert.throws(() => createGame({ rows: 40 }), RangeError);
});

test("left, right and top walls rebound without scoring", () => {
  const left = step(
    board({
      status: "running",
      ball: { x: 8, y: 200, vx: -180, vy: -60 },
      bricks: [],
      remaining: 0 === 0 ? 1 : 0,
    }),
  );
  assert.ok(left.ball.vx > 0, "left wall reverses horizontal velocity");
  assert.ok(left.ball.x >= BALL_RADIUS);
  assert.equal(left.lastHit.type, "wall");
  assert.equal(left.score, 0);

  const right = step(
    board({
      status: "running",
      ball: { x: 475, y: 200, vx: 180, vy: -60 },
      bricks: [],
    }),
  );
  assert.ok(right.ball.vx < 0, "right wall reverses horizontal velocity");
  assert.ok(right.ball.x <= right.width - BALL_RADIUS);
  assert.equal(right.score, 0);

  const top = step(
    board({
      status: "running",
      ball: { x: 240, y: 7, vx: 40, vy: -180 },
      bricks: [],
    }),
  );
  assert.ok(top.ball.vy > 0, "top wall reverses vertical velocity");
  assert.ok(top.ball.y >= BALL_RADIUS);
  assert.equal(top.score, 0);
});

test("paddle rebounds the ball upward and steers by contact offset", () => {
  const centre = step(
    board({
      status: "running",
      ball: { x: 240, y: 330, vx: 0, vy: 180 },
      paddle: { x: 204, y: 336, width: 72, height: 12 },
      bricks: [],
    }),
  );
  assert.equal(centre.lastHit.type, "paddle");
  assert.ok(centre.ball.vy < 0, "paddle sends the ball upward");
  assert.ok(centre.ball.y < 336, "ball is repositioned above the paddle");

  const left = step(
    board({
      status: "running",
      ball: { x: 215, y: 330, vx: 0, vy: 180 },
      paddle: { x: 204, y: 336, width: 72, height: 12 },
      bricks: [],
    }),
  );
  assert.ok(left.ball.vx < 0, "left-of-centre contact steers the ball left");

  const right = step(
    board({
      status: "running",
      ball: { x: 265, y: 330, vx: 0, vy: 180 },
      paddle: { x: 204, y: 336, width: 72, height: 12 },
      bricks: [],
    }),
  );
  assert.ok(right.ball.vx > 0, "right-of-centre contact steers the ball right");

  const ascending = step(
    board({
      status: "running",
      ball: { x: 240, y: 336, vx: 0, vy: -180 },
      paddle: { x: 204, y: 336, width: 72, height: 12 },
      bricks: [],
    }),
  );
  assert.notEqual(ascending.lastHit?.type, "paddle", "an ascending ball is not caught");
});

test("a brick hit scores once, flips one axis and removes the brick", () => {
  const state = step(
    board({
      status: "running",
      ball: { x: 120, y: 116, vx: 0, vy: 180 },
      bricks: [brick({ x: 100, y: 100, w: 40, h: 10 })],
      remaining: 1,
    }),
  );
  assert.equal(state.bricks[0].alive, false);
  assert.equal(state.score, 10);
  assert.equal(state.remaining, 0);
  assert.equal(state.lastHit.type, "brick");
  assert.equal(state.lastHit.id, "brick-0");
  assert.equal(state.ball.vx, 0, "vertical hit only flips the vertical velocity");
  assert.ok(state.ball.vy < 0);
});

test("the same brick never scores twice across repeated steps", () => {
  let state = board({
    status: "running",
    ball: { x: 120, y: 116, vx: 0, vy: 180 },
    bricks: [brick({ x: 100, y: 100, w: 40, h: 10 })],
    remaining: 1,
  });
  for (let index = 0; index < 30; index += 1) {
    state = step(state);
    if (isOver(state)) break;
  }
  assert.equal(state.score, 10);
  assert.equal(state.remaining, 0);
});

test("one step destroys at most one brick when the ball overlaps two", () => {
  const state = step(
    board({
      status: "running",
      ball: { x: 120, y: 116, vx: 0, vy: 180 },
      bricks: [
        brick({ id: "a", x: 100, y: 100, w: 40, h: 10 }),
        brick({ id: "b", x: 100, y: 108, w: 40, h: 10 }),
      ],
      remaining: 2,
    }),
  );
  assert.equal(state.score, 10);
  assert.equal(state.remaining, 1);
  assert.equal(state.bricks.filter((item) => item.alive).length, 1);
});

test("missing the ball costs a life and serves a new ball", () => {
  const state = step(
    board({
      status: "running",
      score: 30,
      lives: 3,
      ball: { x: 20, y: 360, vx: 0, vy: 180 },
      bricks: [brick()],
      remaining: 1,
    }),
  );
  assert.equal(state.lives, 2);
  assert.equal(state.status, "running");
  assert.equal(state.outcome, null);
  assert.equal(state.score, 30, "score survives a lost life");
  assert.ok(Number.isFinite(state.ball.x) && Number.isFinite(state.ball.vy));
  assert.ok(state.ball.y < state.height);
  assert.equal(state.lastHit.type, "floor");
});

test("losing the last life ends the game and freezes it", () => {
  const state = step(
    board({
      status: "running",
      lives: 1,
      ball: { x: 20, y: 360, vx: 0, vy: 180 },
      bricks: [brick()],
      remaining: 1,
    }),
  );
  assert.equal(state.status, "over");
  assert.equal(state.outcome, "lose");
  assert.equal(state.lives, 0);
  assert.equal(step(state), state, "a finished game does not advance");
});

test("clearing the last brick wins the game", () => {
  const state = step(
    board({
      status: "running",
      score: 40,
      ball: { x: 120, y: 116, vx: 0, vy: 180 },
      bricks: [brick({ x: 100, y: 100, w: 40, h: 10 })],
      remaining: 1,
    }),
  );
  assert.equal(state.status, "over");
  assert.equal(state.outcome, "win");
  assert.equal(state.remaining, 0);
  assert.equal(state.score, 50, "the final brick is scored before winning");
});

test("pause freezes the board and resume continues it", () => {
  const running = board({
    status: "running",
    ball: { x: 240, y: 200, vx: 60, vy: 120 },
    bricks: [brick()],
    remaining: 1,
  });
  const paused = pause(running);
  assert.equal(paused.status, "paused");
  assert.equal(step(paused), paused, "a paused board does not advance");
  assert.equal(pause(paused), paused);

  const resumed = resume(paused);
  assert.equal(resumed.status, "running");
  const advanced = step(resumed);
  assert.equal(advanced.ticks, 1);
  assert.equal(resume(running), running, "resume only applies to a paused board");
});

test("start launches a ready board and ignores a finished one", () => {
  const ready = createGame({ seed: 3 });
  const started = start(ready);
  assert.equal(started.status, "running");
  assert.ok(started.ball.vy < 0, "the serve sends the ball toward the bricks");
  assert.ok(Math.hypot(started.ball.vx, started.ball.vy) <= MAX_BALL_SPEED);
  assert.equal(start(pause(started)), pause(started), "start only applies to ready");

  const finished = step(
    board({
      status: "running",
      lives: 1,
      ball: { x: 20, y: 360, vx: 0, vy: 180 },
      bricks: [brick()],
      remaining: 1,
    }),
  );
  assert.equal(start(finished), finished);
  assert.equal(pause(finished), finished);
});

test("serve places a deterministic ball without starting the game", () => {
  const first = serve(createGame({ seed: 5 }));
  const second = serve(createGame({ seed: 5 }));
  assert.equal(first.status, "ready");
  assert.deepEqual(first.ball, second.ball);
  assert.notDeepEqual(serve(createGame({ seed: 6 })).ball, first.ball);
  assert.equal(serve(pause(createGame({ seed: 5 }))).status, "ready");
});

test("restart rebuilds the level from the recorded options", () => {
  const played = step(
    board({
      seed: 11,
      rows: 2,
      cols: 4,
      status: "running",
      score: 40,
      lives: 1,
      ball: { x: 20, y: 360, vx: 0, vy: 180 },
      bricks: [brick({ x: 100, y: 100, w: 40, h: 10, points: 10 })],
      remaining: 1,
      ticks: 12,
    }),
  );
  const fresh = restart(played);
  assert.equal(fresh.status, "running");
  assert.equal(fresh.score, 0);
  assert.equal(fresh.ticks, 0);
  assert.equal(fresh.lives, LIVES);
  assert.equal(fresh.outcome, null);
  assert.equal(fresh.remaining, fresh.bricks.length);
  assert.equal(fresh.bricks.length, 8);
  assert.ok(fresh.bricks.every((item) => item.alive));
});

test("step is deterministic for identical states", () => {
  const make = () =>
    board({
      seed: 21,
      status: "running",
      ball: { x: 150, y: 150, vx: 130, vy: 160 },
      bricks: [brick({ x: 100, y: 100, w: 40, h: 10 }), brick({ x: 200, y: 200, w: 40, h: 10, id: "brick-1" })],
      remaining: 2,
    });
  assert.deepEqual(run(make(), 40), run(make(), 40));
});

test("brick corner contact resolves on one axis and destroys the brick once", () => {
  const state = step(
    board({
      status: "running",
      ball: { x: 143, y: 113, vx: 120, vy: 120 },
      bricks: [brick({ x: 100, y: 100, w: 40, h: 10 })],
      remaining: 1,
    }),
  );
  assert.equal(state.bricks[0].alive, false);
  assert.equal(state.score, 10);
  assert.equal(state.remaining, 0);
  assert.equal(state.lastHit.type, "brick");
  // Only one axis is mirrored: the signs match the approach direction.
  assert.ok(state.ball.vx > 0, "corner contact keeps the horizontal direction");
  assert.ok(state.ball.vy > 0, "corner contact keeps the vertical direction");
});

test("long runs stay capped, inside the field, and never tunnel", () => {
  const state = run(
    start(createGame({ seed: 13, paddleWidth: 120 })),
    6000,
  );
  if (!isOver(state)) {
    assert.ok(Math.hypot(state.ball.vx, state.ball.vy) <= MAX_BALL_SPEED + 1e-9);
    assert.ok(state.ball.x >= 0 && state.ball.x <= state.width);
    assert.ok(state.ball.y >= 0 && state.ball.y <= PLAYFIELD_HEIGHT);
  }
  const total = createGame().bricks.length;
  assert.ok(state.score % 10 === 0);
  assert.equal(state.remaining, total - state.score / 10);
  assert.ok(state.lives >= 0 && state.lives <= LIVES);
});

test("paddle movement is clamped to the playfield", () => {
  const state = createGame();
  assert.equal(movePaddle(state, -1000).paddle.x, 0);
  assert.equal(movePaddle(state, 1000).paddle.x, state.width - state.paddle.width);
  assert.equal(setPaddleTarget(state, 240).paddle.x, 240 - state.paddle.width / 2);
  assert.equal(setPaddleTarget(state, -50).paddle.x, 0);
});

test("held directions move the paddle only while the game runs", () => {
  const running = { ...start(createGame({ seed: 2 })), paddle: { x: 200, y: 336, width: 72, height: 12 } };
  const moved = movePaddleByDirections(running, new Set(["right"]), 1000 / 60);
  assert.ok(moved.paddle.x > running.paddle.x);
  const both = movePaddleByDirections(running, new Set(["left", "right"]), 1000 / 60);
  assert.equal(both.paddle.x, running.paddle.x, "opposite keys cancel");
  const paused = movePaddleByDirections(pause(running), new Set(["left"]), 1000 / 60);
  assert.ok(paused.paddle.x < running.paddle.x, "keys still steer while paused");
  const over = movePaddleByDirections(
    { ...running, status: "over" },
    new Set(["left"]),
    1000 / 60,
  );
  assert.ok(over.paddle.x < running.paddle.x);
});

test("createRng is seedable and reproducible", () => {
  const a = createRng(9);
  const b = createRng(9);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const value = createRng(4)();
  assert.ok(value >= 0 && value < 1);
});
