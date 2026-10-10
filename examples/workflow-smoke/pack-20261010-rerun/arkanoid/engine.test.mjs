// Deterministic rules tests for the Arkanoid engine.
// Run: node --test examples/workflow-smoke/pack-20261010-rerun/arkanoid/engine.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BALL_SPEED,
  DT,
  INITIAL_LIVES,
  MAX_BALL_SPEED,
  MAX_BOUNCE_ANGLE,
  createBricks,
  createGame,
  isOver,
  launch,
  movePaddle,
  pause,
  restart,
  resume,
  start,
  steerPaddle,
  step,
  run,
} from './engine.mjs';

// Small arena with a slow ball by default, so every test controls the whole
// world. The default wall is a single spent brick in the top-left corner, out
// of every test's flight path, so tests inject the wall they actually need.
function arena(overrides = {}) {
  return createGame({
    width: 120,
    height: 90,
    seed: 7,
    ballSpeed: 60,
    maxBallSpeed: 120,
    ballRadius: 4,
    paddle: { width: 30, height: 6, speed: 60 },
    bricks: [deadBrick()],
    ...overrides,
  });
}

function brick(overrides = {}) {
  return {
    id: 0,
    x: 50,
    y: 20,
    width: 20,
    height: 8,
    hits: 1,
    points: 7,
    alive: true,
    ...overrides,
  };
}

function deadBrick() {
  return {
    id: -1,
    x: 0,
    y: 0,
    width: 4,
    height: 4,
    hits: 0,
    points: 0,
    alive: false,
  };
}

function live(s) {
  return { ...s, status: 'running', ball: { ...s.ball, attached: false } };
}

function moving(state, vx, vy, extra = {}) {
  return {
    ...live(state),
    ball: { ...state.ball, vx, vy, ...extra },
  };
}

function speedOf(state) {
  return Math.hypot(state.ball.vx, state.ball.vy);
}

test('initial state is a ready game with three lives', () => {
  const game = createGame({ seed: 42 });
  assert.equal(game.status, 'ready');
  assert.equal(game.outcome, null);
  assert.equal(game.lives, INITIAL_LIVES);
  assert.equal(game.lives, 3);
  assert.equal(game.score, 0);
  assert.equal(game.steps, 0);
  assert.equal(game.level, 1);
  assert.equal(game.ball.attached, true);
  assert.equal(game.ball.x, game.paddle.x);
  assert.equal(game.ball.vx, 0);
  assert.equal(game.ball.vy, 0);
  assert.equal(game.bricksLeft, game.bricks.length);
  assert.equal(game.bricks.every((b) => b.alive), true);
  assert.equal(isOver(game), false);
  assert.equal(game.dt, DT);
});

test('the same seed produces the same layout and the same serve angle', () => {
  const first = createGame({ seed: 1234 });
  const second = createGame({ seed: 1234 });
  const third = createGame({ seed: 1234 });
  assert.deepEqual(second.bricks, first.bricks);
  assert.deepEqual(third.bricks, first.bricks);

  assert.deepEqual(start(second), start(third));
  assert.equal(start(first).ball.vx, start(second).ball.vx);
  assert.equal(start(first).ball.vy, start(second).ball.vy);
  assert.equal(start(first).ball.vy < 0, true);

  assert.notDeepEqual(createGame({ seed: 5 }).bricks, createGame({ seed: 6 }).bricks);
});

test('createGame and createBricks reject degenerate input', () => {
  assert.throws(() => createGame({ width: 0 }), RangeError);
  assert.throws(() => createGame({ height: -5 }), RangeError);
  assert.throws(() => createGame({ width: 40, ballRadius: 40 }), RangeError);
  assert.throws(() => createGame({ paddle: { width: 900 } }), RangeError);
  assert.throws(() => createGame({ bricks: [{ x: 0, y: 0, width: 0, height: 4 }] }), RangeError);
  assert.throws(() => createGame({ bricks: [] }), RangeError);
  assert.throws(() => createBricks({ rows: 2, cols: 2, top: 50, bottom: 20 }), RangeError);
});

test('right wall reverses vx and clamps the ball inside', () => {
  const game = arena();
  const state = moving(game, 60, 20, { x: game.width - 3, y: 45 });
  const next = step(state);
  assert.equal(next.ball.vx < 0, true);
  assert.equal(next.ball.x + next.ball.radius <= game.width, true);
  assert.equal(next.ball.vy, 20);
});

test('left wall reverses vx and clamps the ball inside', () => {
  const game = arena();
  const state = moving(game, -60, 20, { x: 3, y: 45 });
  const next = step(state);
  assert.equal(next.ball.vx > 0, true);
  assert.equal(next.ball.x - next.ball.radius >= 0, true);
});

test('top wall reverses vy', () => {
  const game = arena();
  const state = moving(game, 20, -60, { x: 60, y: 3 });
  const next = step(state);
  assert.equal(next.ball.vy > 0, true);
  assert.equal(next.ball.y - next.ball.radius >= 0, true);
});

test('a ball resting against a wall neither sticks nor drifts', () => {
  const game = arena();
  let state = moving(game, -60, 20, { x: game.ball.radius, y: 45 });
  for (let index = 0; index < 25; index += 1) {
    state = step(state);
    assert.equal(state.ball.x - state.ball.radius >= -1e-9, true);
    assert.equal(state.ball.vx > 0, true);
  }
  const first = step(state);
  const second = step(first);
  assert.equal(
    Math.abs(second.ball.vx) <= Math.abs(first.ball.vx) + 1e-9,
    true,
  );
  assert.equal(
    Math.abs(second.ball.vy) <= Math.abs(first.ball.vy) + 1e-9,
    true,
  );
});

test('a centred paddle hit sends the ball straight back up', () => {
  const game = arena();
  const state = moving(game, 0, 60, { x: game.paddle.x, y: game.paddle.y - 5 });
  const next = step(state);
  assert.equal(next.ball.vy < 0, true);
  assert.equal(next.ball.vx, 0);
  assert.equal(next.ball.y + next.ball.radius < game.paddle.y, true);
  assert.ok(Math.abs(speedOf(next) - 60) < 1e-9);
});

test('an off-centre paddle hit angles the rebound to the matching side', () => {
  const game = arena();
  const right = step(
    moving(game, 0, 60, { x: game.paddle.x + game.paddle.width / 2 - 2, y: game.paddle.y - 5 }),
  );
  const left = step(
    moving(game, 0, 60, { x: game.paddle.x - game.paddle.width / 2 + 2, y: game.paddle.y - 5 }),
  );
  assert.equal(right.ball.vx > 0, true);
  assert.equal(left.ball.vx < 0, true);
  assert.equal(right.ball.vy < 0, true);
  assert.equal(left.ball.vy < 0, true);
  const magnitude = 60;
  assert.ok(
    Math.abs(right.ball.vx) <= magnitude * Math.sin(MAX_BOUNCE_ANGLE) + 1e-9,
  );
  assert.ok(Math.abs(speedOf(right) - magnitude) < 1e-9);
  assert.ok(Math.abs(speedOf(left) - magnitude) < 1e-9);
});

test('a rising ball is not captured by the paddle', () => {
  const game = arena();
  const state = moving(game, 0, -60, { x: game.paddle.x, y: game.paddle.y - 5 });
  const next = step(state);
  assert.equal(next.ball.vy < 0, true);
  assert.equal(next.ball.vx, 0);
});

test('a brick hit bounces, scores once, and cannot score twice', () => {
  const game = arena();
  const wall = [brick({ x: 50, y: 20, width: 20, height: 8, points: 7 })];
  const state = { ...moving(game, 0, -60, { x: 60, y: 33 }), bricks: wall };
  const next = step(state);
  assert.equal(next.ball.vy > 0, true);
  assert.equal(next.ball.vx, 0);
  assert.equal(next.score, 7);
  assert.equal(next.bricksLeft, 0);
  assert.equal(next.bricks[0].alive, false);
  assert.equal(next.bricks[0].hits, 0);

  // The reflected ball is outside the brick, so the next substep scores nothing.
  const after = step(next);
  assert.equal(after.score, 7);
  assert.equal(after.bricksLeft, 0);
});

test('a side impact reverses vx and a reinforced brick survives its first hit', () => {
  const game = arena();
  const wall = [brick({ x: 50, y: 20, width: 20, height: 8, hits: 2, points: 14 })];
  const state = { ...moving(game, 60, 0, { x: 45, y: 24 }), bricks: wall };
  const next = step(state);
  assert.equal(next.ball.vx < 0, true);
  assert.equal(next.ball.vy, 0 + 60 - 60);
  assert.equal(next.score, 0);
  assert.equal(next.bricksLeft, 1);
  assert.equal(next.bricks[0].alive, true);
  assert.equal(next.bricks[0].hits, 1);

  const second = { ...next, ball: { ...next.ball, x: 75, vx: -60 } };
  const cleared = step(second);
  assert.equal(cleared.score, 14);
  assert.equal(cleared.bricksLeft, 0);
  assert.equal(cleared.bricks[0].alive, false);
});

test('dead bricks are skipped', () => {
  const game = arena();
  const wall = [brick({ x: 50, y: 20, width: 20, height: 8, hits: 0, alive: false })];
  const state = { ...moving(game, 0, -60, { x: 60, y: 30, vy: -60 }), bricks: wall };
  const next = step(state);
  assert.equal(next, state);
  assert.equal(next.score, 0);
});

test('a ball dropped past the bottom costs a life and serves a new ball', () => {
  const game = arena();
  const state = moving(game, 30, 60, { x: 40, y: game.height - 2 });
  const next = step(state);
  assert.equal(next.lives, game.lives - 1);
  assert.equal(next.status, 'ready');
  assert.equal(next.outcome, null);
  assert.equal(next.ball.attached, true);
  assert.equal(next.ball.x, next.paddle.x);
  assert.equal(next.ball.vx, 0);
  assert.equal(next.ball.vy, 0);
  assert.equal(next.score, 0);
  assert.equal(isOver(next), false);
});

test('losing the last life ends the game as a loss', () => {
  const game = arena({ lives: 1 });
  const state = moving(game, 0, 60, { x: 60, y: game.height - 2 });
  const over = step(state);
  assert.equal(over.lives, 0);
  assert.equal(over.status, 'over');
  assert.equal(over.outcome, 'lose');
  assert.equal(isOver(over), true);
  assert.equal(step(over), over);
  assert.equal(start(over), over);
  assert.equal(pause(over), over);
  assert.equal(resume(over), over);
  assert.equal(run(over, 5), over);
});

test('clearing the last brick wins the game', () => {
  const game = arena();
  const wall = [brick({ x: 50, y: 20, width: 20, height: 8, points: 25 })];
  const state = { ...moving(game, 0, -60, { x: 60, y: 33 }), bricks: wall };
  const over = step(state);
  assert.equal(over.status, 'over');
  assert.equal(over.outcome, 'win');
  assert.equal(over.score, 25);
  assert.equal(over.bricksLeft, 0);
  assert.equal(isOver(over), true);
  assert.equal(run(over, 4), over);
});

test('pause freezes the world, resume continues, and illegal transitions are identity', () => {
  const game = arena();
  const state = moving(game, 20, 20, { x: 40, y: 40 });
  const paused = pause(state);
  assert.equal(paused.status, 'paused');
  assert.equal(step(paused), paused);
  assert.equal(run(paused, 3), paused);
  assert.equal(pause(paused), paused);
  assert.equal(start(paused), paused);
  assert.equal(launch(paused), paused);

  const resumed = resume(paused);
  assert.equal(resumed.status, 'running');
  assert.equal(resume(resumed), resumed);
  assert.equal(resumed.steps, state.steps);
  const advanced = step(resumed);
  assert.equal(advanced.steps, state.steps + 1);
  assert.notEqual(advanced, resumed);

  assert.equal(pause(game), game);
  assert.equal(steerPaddle(game, 'up'), game);
  assert.throws(() => steerPaddle(game, 5), TypeError);

  // Pausing before the ball is launched counts as the missed serve.
  const dropped = pause(game);
  assert.equal(dropped.lives, game.lives - 1);
  assert.equal(dropped.status, 'ready');
});

test('restart rebuilds bricks, score, lives and steps and plays on', () => {
  const game = arena({ seed: 3, bricks: [brick({ points: 7 })] });
  const scored = {
    ...moving(game, 0, -60, { x: 60, y: 33, vy: -60 }),
    score: 7,
    steps: 11,
    lives: 1,
  };
  const fresh = restart(scored);
  assert.equal(fresh.status, 'running');
  assert.equal(fresh.outcome, null);
  assert.equal(fresh.score, 0);
  assert.equal(fresh.lives, INITIAL_LIVES);
  assert.equal(fresh.steps, 0);
  assert.equal(fresh.bricksLeft, fresh.bricks.length);
  assert.equal(fresh.bricks.every((b) => b.alive), true);
  assert.equal(fresh.ball.attached, false);
  assert.equal(isOver(fresh), false);
  assert.equal(restart(fresh).steps, 0);
});

test('run advances a fixed number of substeps and halts at game over', () => {
  const game = arena();
  const state = moving(game, 0, 20, { x: 60, y: 40 });
  assert.equal(run(state, 0), state);
  assert.equal(run(state, 3).steps, 3);
  assert.equal(run(state, 3).ball.y, state.ball.y + 20 * DT * 3);
  assert.equal(run(state, 1), step(state));

  const doomed = moving(game, 0, 60, { x: 60, y: game.height - 2 });
  assert.equal(run(doomed, 10).status, 'ready');
  assert.equal(run(doomed, 10).lives, game.lives - 1);

  const won = {
    ...moving(game, 0, -60, { x: 60, y: 33, vy: -60 }),
    bricks: [brick({ points: 3 })],
  };
  assert.equal(run(won, 10).outcome, 'win');
});

test('a corner contact flips one axis and ejects the ball clear of the brick', () => {
  const game = arena();
  const wall = [brick({ x: 50, y: 20, width: 20, height: 8 })];
  const state = { ...moving(game, 40, -60, { x: 48.2, y: 31.8 }), bricks: wall };
  const next = step(state);

  assert.equal(next.ball.vy < 0, true, 'ball keeps rising');
  assert.equal(next.ball.vx, 40, 'only the vertical component flips');
  assert.equal(next.score, 7);
  assert.equal(next.bricksLeft, 0);

  // Out of the brick, so the next substep is a clean flight.
  const after = step(next);
  assert.equal(after.ball.vy < 0, true);
  assert.equal(after.ball.vx, 40);
  assert.equal(after.score, 7);
  assert.equal(
    after.ball.y + after.ball.radius <= wall[0].y + 1e-9,
    true,
  );
});

test('a ball wedged into a brick pocket leaves on one axis', () => {
  const game = arena();
  const wall = [
    brick({ id: 0, x: 40, y: 20, width: 20, height: 8 }),
    brick({ id: 1, x: 64, y: 20, width: 20, height: 8 }),
  ];
  const state = { ...moving(game, 60, -10, { x: 62, y: 26 }), bricks: wall };
  const next = step(state);
  assert.equal(next.ball.vx < 0, true);
  assert.equal(next.ball.vy, -10);
  assert.equal(next.score, 7);
});

test('ball speed is capped and the vertical component never vanishes', () => {
  const game = arena();
  let state = {
    ...moving(game, 0, 0, { x: 60, y: 40 }),
    bricks: [brick({ x: 55, y: 26, width: 10, height: 4, points: 1 })],
  };
  state = { ...state, ball: { ...state.ball, vx: 0.2, vy: -0.2 } };
  const first = step(state);
  assert.equal(first.ball.vy < 0, true);
  assert.equal(Math.abs(first.ball.vy) >= 60, true);

  const fast = moving(game, 900, -900, { x: 60, y: 45 });
  const capped = step(fast);
  assert.equal(speedOf(capped) <= MAX_BALL_SPEED, true);
  assert.equal(speedOf(capped) <= game.ballSpeed + 1e-9, true);
});

test('paddle controls clamp to the arena and carry an attached ball', () => {
  const game = arena();
  assert.equal(movePaddle(game, -100).paddle.x, game.paddle.width / 2);
  assert.equal(movePaddle(game, 1e6).paddle.x, game.width - game.paddle.width / 2);
  assert.equal(movePaddle(game, game.paddle.x), game);
  const centred = movePaddle(game, 80);
  assert.equal(centred.paddle.x, 80);
  assert.equal(centred.ball.x, 80);

  const steered = steerPaddle(game, 'right');
  assert.equal(steered.paddle.x, game.paddle.x + game.paddle.speed * DT);
  assert.equal(
    steerPaddle(steered, 'left').paddle.x,
    movePaddle(steered, steered.paddle.x - game.paddle.speed * DT).paddle.x,
  );
});

test('a full seeded game is deterministic across identical runs', () => {
  const play = () => {
    let state = start(createGame({ seed: 99, paddle: { width: 260 } }));
    for (let index = 0; index < 400; index += 1) {
      const steered = steerPaddle(state, state.ball.x < state.paddle.x ? 'right' : 'left');
      state = step(steered);
      if (isOver(state) || state.status === 'ready') {
        break;
      }
    }
    return {
      score: state.score,
      lives: state.lives,
      status: state.status,
      outcome: state.outcome,
      steps: state.steps,
      bricksLeft: state.bricksLeft,
      ball: state.ball,
    };
  };
  assert.deepEqual(play(), play());
});

test('engine constants match the documented defaults', () => {
  const game = createGame({ seed: 1 });
  assert.equal(game.ball.radius, 7);
  assert.equal(game.lives, 3);
  assert.equal(game.bricks.length, 40);
  assert.equal(BALL_SPEED, 360);
});
