// Run: node --test examples/workflow-smoke/pack-20261010/arkanoid/engine.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  BASE_BALL_SPEED,
  BRICK_COLUMNS,
  BRICK_HEIGHT,
  BRICK_POINTS,
  BRICK_ROWS,
  LIVES,
  MAX_BALL_SPEED,
  MAX_STEP_MS,
  PADDLE_HEIGHT,
  PADDLE_SPEED,
  PADDLE_TRACK_MARGIN,
  STEP_MS,
  advance,
  advanceBall,
  createGame,
  createRng,
  isOver,
  isPaused,
  movePaddle,
  movePaddleBy,
  pause,
  resume,
  restart,
  serve,
  setPaddleCenter,
  setPaddleVelocity,
  start,
  step,
  trackPaddle,
} from "./engine.mjs";

// A small, fully specified board keeps the arithmetic trivially auditable.
const board = {
  width: 240,
  height: 240,
  seed: 42,
  ballRadius: 5,
  paddleWidth: 40,
  paddleHeight: PADDLE_HEIGHT,
  paddleY: 200,
  paddleSpeed: PADDLE_SPEED,
  ballSpeed: 120,
  lives: LIVES,
};

function singleBrick(overrides = {}) {
  return [
    {
      id: 0,
      x: 100,
      y: 100,
      width: 40,
      height: BRICK_HEIGHT,
      points: 5,
      alive: true,
      ...overrides,
    },
  ];
}

function running(overrides = {}) {
  return start(createGame({ ...board, ...overrides }));
}

function hypot(ball) {
  return Math.hypot(ball.vx, ball.vy);
}

function inPlayfield(state) {
  return (
    state.ball.x >= state.ball.radius - 1e-6 &&
    state.ball.x <= state.width - state.ball.radius + 1e-6 &&
    state.ball.y >= state.ball.radius - 1e-6 &&
    state.ball.y <= state.height + state.ball.radius
  );
}

test("initial state is a ready board with three lives and a full brick wall", () => {
  const game = createGame(board);

  assert.equal(game.status, "ready");
  assert.equal(game.outcome, null);
  assert.equal(game.score, 0);
  assert.equal(game.lives, 3);
  assert.equal(game.lives, LIVES);
  assert.equal(game.steps, 0);
  assert.equal(game.bricks.length, BRICK_COLUMNS * BRICK_ROWS);
  assert.ok(game.bricks.every((brick) => brick.alive));
  assert.ok(inPlayfield(game));
  assert.equal(isOver(game), false);

  // A ready board is inert: stepping it returns the very same object.
  assert.equal(step(game, { dtMs: STEP_MS }), game);
});

test("start serves a deterministic ball from the injected rng", () => {
  const first = start(createGame({ ...board, seed: 7 }));
  const second = start(createGame({ ...board, seed: 7 }));

  assert.equal(first.status, "running");
  assert.deepEqual(first.ball, second.ball);
  assert.ok(first.ball.vy < 0, "the serve travels upward");
  assert.ok(Math.abs(hypot(first.ball) - 120) < 1e-6);
  assert.ok(inPlayfield(first));

  const other = start(createGame({ ...board, seed: 999 }));
  assert.notDeepEqual(first.ball, other.ball, "a different seed serves a different angle");
});

test("start ignores a finished game and a running game", () => {
  const over = createGame({ ...board, status: "over", outcome: "lose" });
  assert.equal(start(over), over);

  const game = running({ ball: { x: 100, y: 160, vx: 0, vy: 60 } });
  assert.equal(start(game), game);
});

test("left and right wall rebounds flip vx and keep the ball inside", () => {
  const left = step(
    running({
      ball: { x: 40, y: 120, vx: -120, vy: -60 },
      bricks: [],
    }),
    { dtMs: 100 },
  );
  assert.ok(left.ball.vx > 0, "the left wall reverses horizontal velocity");
  assert.ok(left.ball.x >= left.ball.radius - 1e-6);
  assert.ok(left.ball.y < 120, "vertical motion is untouched by a side wall");

  const right = step(
    running({
      ball: { x: 200, y: 120, vx: 120, vy: -60 },
      bricks: [],
    }),
    { dtMs: 100 },
  );
  assert.ok(right.ball.vx < 0, "the right wall reverses horizontal velocity");
  assert.ok(right.ball.x <= right.width - right.ball.radius + 1e-6);
});

test("top wall rebound turns the ball back downward", () => {
  const state = step(
    running({
      ball: { x: 120, y: 8, vx: 30, vy: -120 },
      bricks: [],
    }),
    { dtMs: 100 },
  );

  assert.ok(state.ball.vy > 0, "the ceiling pushes the ball down");
  assert.ok(state.ball.y >= state.ball.radius - 1e-6);
  assert.equal(state.score, 0);
});

test("the bottom edge costs a life and serves a new ball", () => {
  const game = running({ ball: { x: 120, y: 236, vx: 0, vy: 120 }, bricks: [] });
  const after = step(game, { dtMs: STEP_MS });

  assert.equal(after.lives, LIVES - 1);
  assert.equal(after.status, "running", "the next ball is served automatically");
  assert.equal(after.outcome, null);
  assert.ok(inPlayfield(after), "the new ball starts inside the playfield");
  assert.ok(after.ball.vy < 0, "the new ball is served upward");

  const replay = step(
    running({ ball: { x: 120, y: 236, vx: 0, vy: 120 }, bricks: [], seed: 42 }),
    { dtMs: STEP_MS },
  );
  assert.deepEqual(after.ball, replay.ball, "the same seed re-serves the same ball");
});

test("three drops end the game as a loss and freeze the engine", () => {
  let state = running({ ball: { x: 120, y: 236, vx: 0, vy: 120 }, bricks: [] });
  for (let drop = 0; drop < 3; drop += 1) {
    // Park the freshly served ball back on the drop line each time.
    state = { ...state, ball: { ...state.ball, x: 120, y: 236, vx: 0, vy: 120 } };
    state = step(state, { dtMs: STEP_MS });
  }

  assert.equal(state.lives, 0);
  assert.equal(state.status, "over");
  assert.equal(state.outcome, "lose");
  assert.equal(isOver(state), true);
  assert.equal(step(state, { dtMs: STEP_MS }), state, "a finished game is inert");
  assert.equal(advance(state, 10, { dtMs: STEP_MS }), state);
});

test("a brick hit scores its points, flips the normal, and removes the brick", () => {
  const state = step(
    running({ ball: { x: 120, y: 90, vx: 0, vy: 120 }, bricks: singleBrick() }),
    { dtMs: 100 },
  );

  assert.equal(state.bricks[0].alive, false);
  assert.equal(state.score, BRICK_POINTS[2] === 4 ? 5 : 5);
  assert.equal(state.score, 5, "the brick is credited once");
  assert.ok(state.ball.vy < 0, "a top-face hit sends the ball back up");
  assert.equal(state.status, "running", "one brick left standing is not a win");
});

test("a cleared brick never scores or disappears twice", () => {
  const first = step(
    running({ ball: { x: 120, y: 90, vx: 0, vy: 120 }, bricks: singleBrick() }),
    { dtMs: 100 },
  );
  assert.equal(first.score, 5);

  // Park the ball exactly on the dead brick and keep stepping through it.
  let state = { ...first, ball: { ...first.ball, x: 120, y: 105, vx: 0, vy: 120 } };
  for (let i = 0; i < 25; i += 1) {
    state = step(state, { dtMs: STEP_MS });
  }
  assert.equal(state.score, 5, "no double scoring");
  assert.equal(state.bricks.filter((brick) => brick.alive).length, 0);
});

test("clearing every brick wins the game", () => {
  const state = step(
    running({ ball: { x: 120, y: 90, vx: 0, vy: 120 }, bricks: singleBrick() }),
    { dtMs: 100 },
  );

  assert.equal(state.status, "over");
  assert.equal(state.outcome, "win");
  assert.equal(state.lives, LIVES, "winning does not cost a life");
  assert.equal(state.score, 5);
  assert.equal(step(state, { dtMs: STEP_MS }), state);
});

test("paddle rebound sends the ball up and steers by contact offset", () => {
  const centre = step(
    running({ ball: { x: 120, y: 194, vx: 0, vy: 120 }, bricks: [], paddle: null }),
    { dtMs: STEP_MS },
  );
  assert.ok(centre.ball.vy < 0, "the paddle always deflects upward");
  assert.equal(centre.ball.vx, 0, "a dead-centre hit keeps the ball vertical");
  assert.ok(centre.ball.y < centre.paddle.y, "the ball leaves the paddle face");

  const leftEdge = step(
    running({ ball: { x: 102, y: 194, vx: 0, vy: 120 }, bricks: [] }),
    { dtMs: STEP_MS },
  );
  assert.ok(leftEdge.ball.vx < 0, "the left half of the paddle sends the ball left");

  const rightEdge = step(
    running({ ball: { x: 138, y: 194, vx: 0, vy: 120 }, bricks: [] }),
    { dtMs: STEP_MS },
  );
  assert.ok(rightEdge.ball.vx > 0, "the right half of the paddle sends the ball right");
});

test("a fast ball cannot tunnel through the paddle", () => {
  // MAX_BALL_SPEED for 100ms is 35px of travel, which straddles the paddle band.
  const state = step(
    running({
      ball: { x: 120, y: 190, vx: 0, vy: MAX_BALL_SPEED },
      bricks: [],
      ballSpeed: MAX_BALL_SPEED,
    }),
    { dtMs: MAX_STEP_MS },
  );

  assert.ok(state.ball.vy < 0, "the paddle catches the fastest legal ball");
  assert.ok(state.ball.y < state.paddle.y, "the ball is placed above the paddle");
  assert.equal(state.lives, LIVES, "no life is lost on a paddle save");
});

test("speed is normalised and capped after every bounce", () => {
  let state = running({
    ball: { x: 120, y: 90, vx: 0, vy: 120 },
    bricks: singleBrick({ y: 90, height: 6, points: 1 }),
    ballSpeed: MAX_BALL_SPEED,
  });
  state = advance(state, 400, { dtMs: STEP_MS });

  assert.ok(hypot(state.ball) <= MAX_BALL_SPEED + 1e-6, "the ball stays under the cap");
  assert.ok(hypot(state.ball) >= 1, "the ball never stalls");
  assert.ok(
    Math.abs(state.ball.vy) >= hypot(state.ball) * 0.3,
    "the ball never locks into a horizontal loop",
  );
});

test("the ball always stays inside the playfield for a long rally", () => {
  let state = running({ seed: 20261010 });
  for (let i = 0; i < 1500; i += 1) {
    state = advanceBall(state, { dtMs: STEP_MS });
    assert.ok(state.ball.x >= state.ball.radius - 1e-6, `left bound at step ${i}`);
    assert.ok(state.ball.x <= state.width - state.ball.radius + 1e-6, `right bound at step ${i}`);
    assert.ok(state.ball.y >= state.ball.radius - 1e-6, `top bound at step ${i}`);
    assert.ok(state.ball.y <= state.height + state.ball.radius, `bottom bound at step ${i}`);
    if (isOver(state)) break;
  }
  assert.ok(state.steps > 10, "the rally actually runs");
});

test("pause freezes the simulation and resume continues it", () => {
  const game = running({ ball: { x: 120, y: 120, vx: 60, vy: -90 }, bricks: [] });
  const paused = pause(game);

  assert.equal(paused.status, "paused");
  assert.equal(isPaused(paused), true);
  assert.equal(step(paused, { dtMs: STEP_MS }), paused, "a paused board is inert");
  assert.equal(advance(paused, 20, { dtMs: STEP_MS }), paused);
  assert.equal(pause(paused), paused);

  let state = advance(game, 10, { dtMs: STEP_MS });
  const snapshot = { x: state.ball.x, y: state.ball.y, steps: state.steps };
  const frozen = pause(state);
  state = advance(frozen, 10, { dtMs: STEP_MS });
  assert.equal(state, frozen, "nothing advances while paused");

  const resumed = resume(frozen);
  assert.equal(resumed.status, "running");
  assert.equal(resume(resumed), resumed);
  state = advance(resumed, 10, { dtMs: STEP_MS });
  assert.notEqual(state.ball.x, snapshot.x, "the rally continues after resuming");
  assert.equal(resume(game), game, "resume only applies to a paused board");
});

test("restart and serve rebuild a clean, running board", () => {
  let state = running({ seed: 5 });
  for (let i = 0; i < 200; i += 1) {
    state = step(state, { dtMs: STEP_MS });
  }
  const dirty = advance(state, 60, { dtMs: STEP_MS });

  const fresh = restart(board);
  assert.equal(fresh.score, 0);
  assert.equal(fresh.lives, LIVES);
  assert.equal(fresh.steps, 0);
  assert.equal(fresh.status, "running");
  assert.equal(fresh.outcome, null);
  assert.equal(fresh.bricks.filter((brick) => brick.alive).length, dirty.bricks.length);

  const dropped = step(
    running({ ball: { x: 120, y: 236, vx: 0, vy: 120 }, bricks: [], seed: 3 }),
    { dtMs: STEP_MS },
  );
  assert.equal(dropped.lives, LIVES - 1);
  const served = serve(dropped);
  assert.equal(served.lives, LIVES, "serve refills lives for a fresh rally");
  assert.equal(served.status, "running");
  assert.ok(served.ball.vy < 0);
});

test("paddle controls clamp to the playfield", () => {
  const game = createGame(board);
  assert.equal(movePaddle(game, -1000).paddle.x, 0);
  assert.equal(movePaddle(game, 1000).paddle.x, game.width - game.paddle.width);
  assert.equal(setPaddleCenter(game, -500).paddle.x, 0);
  assert.equal(setPaddleCenter(game, 1e6).paddle.x, game.width - game.paddle.width);
  assert.equal(movePaddleBy(game, 12).paddle.x, round(game.paddle.x + 12));
  assert.equal(setPaddleVelocity(game, 2).paddle.velocity, game.paddle.speed);
  assert.equal(setPaddleVelocity(game, -2).paddle.velocity, -game.paddle.speed);
});

test("the keyboard paddle moves at speed and never leaves the playfield", () => {
  let state = createGame({ ...board, paddleSpeed: 200 });
  for (let i = 0; i < 40; i += 1) {
    state = movePaddleBy(state, -200 * (STEP_MS / 1000), { dtMs: STEP_MS });
    assert.ok(state.paddle.x >= 0);
  }
  assert.equal(state.paddle.x, 0, "holding left parks the paddle on the wall");

  for (let i = 0; i < 200; i += 1) {
    state = movePaddleBy(state, 200 * (STEP_MS / 1000), { dtMs: STEP_MS });
    assert.ok(state.paddle.x + state.paddle.width <= state.width);
  }
  assert.equal(state.paddle.x + state.paddle.width, state.width);
});

test("the paddle follows the ball with a speed cap and no teleporting", () => {
  let state = running({
    ball: { x: 60, y: 120, vx: 90, vy: -120 },
    bricks: [],
    seed: 11,
  });
  let previous = state.paddle.x;
  const maxTravel = PADDLE_SPEED * (STEP_MS / 1000);
  for (let i = 0; i < 600; i += 1) {
    state = advanceBall(state, { dtMs: STEP_MS });
    assert.ok(Math.abs(state.paddle.x - previous) <= maxTravel + 1e-9, "no paddle teleport");
    previous = state.paddle.x;
    assert.ok(state.paddle.x >= 0 && state.paddle.x + state.paddle.width <= state.width);
    if (isOver(state)) break;
  }
  assert.equal(isOver(state), false, "tracking keeps the rally alive");
  assert.ok(Math.abs(state.paddle.x + state.paddle.width / 2 - state.ball.x) <= state.paddle.width / 2);

  // Tracking honours its tolerance band: a target already inside the margin
  // leaves the paddle exactly where it was.
  const idle = createGame({ ...board, paddleX: 100 });
  assert.equal(
    trackPaddle(idle, STEP_MS, { targetX: 100 + 20 + PADDLE_TRACK_MARGIN }),
    idle,
  );
});

test("an edge collision resolves deterministically", () => {
  const ball = { x: 141, y: 94, vx: 120, vy: 120 };
  const first = step(running({ ball, bricks: singleBrick() }), { dtMs: STEP_MS });
  const again = step(running({ ball, bricks: singleBrick() }), { dtMs: STEP_MS });

  assert.deepEqual(first.ball, again.ball, "the same input gives the same output");
  assert.equal(first.score, 5);
  assert.equal(first.bricks[0].alive, false);
  assert.ok(first.ball.vx < 0, "the right-face corner contact reverses vx");
  assert.ok(first.ball.vy > 0, "the corner contact keeps the downward component");
  assert.equal(hypot(first.ball), 120, "a corner hit preserves speed");

  // Grazing the side wall and a brick in the same step resolves the wall first.
  const graze = step(
    running({
      ball: { x: 26, y: 105, vx: -120, vy: 30 },
      bricks: [{ id: 0, x: 5, y: 100, width: 18, height: 12, points: 3, alive: true }],
    }),
    { dtMs: STEP_MS },
  );
  assert.equal(graze.score, 0);
  assert.equal(graze.bricks[0].alive, true);
  assert.ok(graze.ball.vx > 0, "the side wall rebound wins the race");
});

test("rejects unusable board geometry", () => {
  assert.throws(() => createGame({ width: 0 }), RangeError);
  assert.throws(() => createGame({ width: 40, height: 10 }), RangeError);
  assert.throws(() => createGame({ paddleWidth: 0 }), RangeError);
  assert.throws(() => createGame({ lives: -1 }), RangeError);
  assert.throws(() => createGame({ bricks: [{ x: 0, y: 0, width: 0, height: 1 }] }), RangeError);
  assert.throws(() => step(createGame(board), { dtMs: Number.NaN }), RangeError);
});

test("the engine is reproducible across identical replays", () => {
  const runOne = () => {
    let state = running({ seed: 2026 });
    for (let i = 0; i < 500; i += 1) state = advanceBall(state, { dtMs: STEP_MS });
    return {
      score: state.score,
      lives: state.lives,
      steps: state.steps,
      ball: state.ball,
      bricks: state.bricks.map((brick) => brick.alive),
    };
  };

  assert.deepEqual(runOne(), runOne());

  const rng = createRng(1234);
  const values = [rng(), rng(), rng()];
  assert.ok(values.every((value) => value >= 0 && value < 1));
  const rng2 = createRng(1234);
  assert.deepEqual([rng2(), rng2(), rng2()], values);
});

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
