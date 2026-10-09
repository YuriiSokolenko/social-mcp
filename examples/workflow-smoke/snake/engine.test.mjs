import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame,
  freeCells,
  isOver,
  mulberry32,
  pause,
  queueDirection,
  restart,
  spawnFood,
  start,
  step,
  stepMsFor,
  togglePause,
} from './engine.mjs';

// Small grids keep expected cells obvious and full-grid cases cheap. The
// stub rng always draws zero, i.e. the first free cell scanning row by row,
// which for these layouts is (0, 0) and never covered by the snake.
const newGame = ({ food = { x: 0, y: 0 }, ...overrides } = {}) => {
  const state = createGame({ width: 6, height: 5, startLength: 3, rng: () => 0, ...overrides });
  return { ...state, food };
};

const head = (state) => state.snake[0];

test('createGame seeds a horizontal snake on the middle row', () => {
  const game = newGame();
  assert.equal(game.status, 'ready');
  assert.deepEqual(game.snake, [
    { x: 3, y: 2 },
    { x: 2, y: 2 },
    { x: 1, y: 2 },
  ]);
  assert.equal(game.dir, 'right');
  assert.equal(game.score, 0);
  assert.equal(game.ticks, 0);
  assert.equal(freeCells(game).length, 30 - 3 - 1);
});

test('createGame rejects grids too small to move on', () => {
  assert.throws(() => createGame({ width: 2 }), RangeError);
  assert.throws(() => createGame({ height: 1.5 }), RangeError);
});

test('step moves the head one cell per tick without growing', () => {
  const game = start(newGame());
  const moved = step(game);
  assert.deepEqual(head(moved), { x: 4, y: 2 });
  assert.equal(moved.snake.length, 3);
  assert.equal(moved.ticks, 1);
  assert.equal(moved.status, 'running');
  assert.deepEqual(head(game), { x: 3, y: 2 }, 'the previous state is not mutated');
});

test('a queued direction is applied on the next tick', () => {
  const game = start(newGame());
  const queued = queueDirection(game, 'up');
  assert.equal(queued.pendingDir, 'up');
  assert.equal(queued.dir, 'right', 'the live direction is unchanged until the tick');
  assert.deepEqual(head(step(queued)), { x: 3, y: 1 });
});

test('eating grows by one, scores, and respawns food off the snake', () => {
  const game = start(newGame({ food: { x: 4, y: 2 } }));
  const ate = step(game);
  assert.equal(ate.score, 1);
  assert.equal(ate.snake.length, 4);
  assert.deepEqual(head(ate), { x: 4, y: 2 });
  assert.deepEqual(ate.food, { x: 0, y: 0 }, 'food respawns on a free cell');
  assert.ok(!ate.snake.some((p) => p.x === ate.food.x && p.y === ate.food.y));
});

test('wall collision ends the game', () => {
  let game = start(newGame());
  for (let i = 0; i < 4; i += 1) game = step(game);
  assert.equal(game.status, 'over');
  assert.equal(isOver(game), true);
  assert.equal(step(game), game, 'a dead game does not keep moving');
});

test('self collision ends the game', () => {
  let game = start(newGame({ width: 5, height: 5, startLength: 5 }));
  game = step(queueDirection(game, 'down'));
  game = step(queueDirection(game, 'left'));
  game = step(queueDirection(game, 'up'));
  assert.equal(game.status, 'over');
});

test('following the cell the tail just vacated stays alive', () => {
  const game = start(newGame({ width: 4, height: 4, startLength: 4 }));
  const survived = ['up', 'left', 'down'].reduce(
    (acc, name) => step(queueDirection(acc, name)),
    game,
  );
  assert.equal(survived.status, 'running');
});

test('an immediate 180-degree reversal is rejected', () => {
  const game = start(newGame());
  assert.equal(queueDirection(game, 'left'), game);
  assert.equal(queueDirection(game, 'left').pendingDir, 'right');
});

test('two queued turns in one tick cannot compound into a reversal', () => {
  const game = start(newGame());
  const up = queueDirection(game, 'up');
  const left = queueDirection(up, 'left');
  assert.equal(left.pendingDir, 'up', 'the guard compares the live direction');
  assert.equal(left, up, 'the rejected turn leaves state untouched');
  assert.equal(step(left).dir, 'up');
});

test('direction names are case-insensitive, junk is ignored', () => {
  const game = start(newGame());
  assert.equal(queueDirection(game, 'Up').pendingDir, 'up');
  assert.equal(queueDirection(game, 'diagonal'), game);
  assert.equal(queueDirection(game, ''), game);
  assert.equal(queueDirection(game, undefined), game);
});

test('pause blocks step and resume continues from the same cell', () => {
  const running = start(newGame());
  const paused = pause(running);
  assert.equal(paused.status, 'paused');
  assert.equal(step(paused), paused);

  const moved = step(start(paused));
  assert.equal(moved.status, 'running');
  assert.deepEqual(head(moved), { x: 4, y: 2 });
  assert.equal(moved.ticks, 1);
});

test('togglePause starts a ready game and pauses a running one', () => {
  const game = newGame();
  assert.equal(togglePause(game).status, 'running');
  assert.equal(togglePause(start(game)).status, 'paused');
  assert.equal(togglePause(togglePause(game)).status, 'paused');
});

test('restart resets score, length and the game-over flag', () => {
  const dead = step(start(newGame({ width: 5, height: 5, startLength: 5 })));
  const fresh = restart(dead);
  assert.equal(fresh.status, 'ready');
  assert.equal(fresh.score, 0);
  assert.equal(fresh.ticks, 0);
  assert.equal(fresh.snake.length, 5);
  assert.equal(fresh.width, 5);
  assert.equal(fresh.height, 5);
  assert.ok(fresh.food);
});

test('spawnFood is reproducible from a seeded rng and avoids the snake', () => {
  const placements = [];
  for (const seed of [1, 8, 21, 99]) {
    const game = createGame({ width: 7, height: 7, rng: mulberry32(seed) });
    assert.ok(!game.snake.some((p) => p.x === game.food.x && p.y === game.food.y));
    const again = createGame({ width: 7, height: 7, rng: mulberry32(seed) });
    placements.push(JSON.stringify(game.food));
    assert.deepEqual(again.food, game.food);
  }
  assert.equal(new Set(placements).size, 4, 'distinct seeds pick distinct cells');
});

test('spawnFood never returns an out-of-range or occupied cell', () => {
  const game = start(newGame({ width: 4, height: 4, startLength: 3, rng: () => 0.9999 }));
  const next = spawnFood(game);
  assert.ok(next.food.x < 4 && next.food.y < 4);
  assert.ok(!next.snake.some((p) => p.x === next.food.x && p.y === next.food.y));
});

test('spawnFood uses the only free cell on a nearly full grid', () => {
  const nearlyFull = {
    ...newGame(),
    width: 2,
    height: 2,
    snake: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ],
    food: null,
    status: 'running',
  };
  assert.deepEqual(spawnFood(nearlyFull).food, { x: 1, y: 1 });
});

test('a full grid ends the game as won instead of looping', () => {
  const full = {
    ...newGame(),
    width: 2,
    height: 2,
    snake: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ],
    food: null,
    status: 'running',
  };
  const won = spawnFood(full);
  assert.equal(won.food, null);
  assert.equal(won.status, 'won');
  assert.equal(isOver(won), true);
  assert.equal(step(won), won);
});

test('stepMsFor slows the cadence down but never below the floor', () => {
  assert.equal(stepMsFor(0), 110);
  assert.equal(stepMsFor(5), 105);
  assert.equal(stepMsFor(100), 70);
  assert.ok(stepMsFor(9) <= stepMsFor(0));
});
