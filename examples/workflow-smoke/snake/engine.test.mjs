// Deterministic engine tests: no DOM, no timers, no network.
// Run: node --test examples/workflow-smoke/snake/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame,
  createRng,
  pause,
  placeFood,
  queueDirection,
  restart,
  resume,
  run,
  start,
  step,
} from './engine.mjs';

/** Deterministic board builder so each test controls the whole grid. */
function board(overrides = {}) {
  const base = createGame({
    width: overrides.width ?? 6,
    height: overrides.height ?? 6,
    seed: 7,
  });
  return {
    ...base,
    snake: overrides.snake ?? ['3,3', '2,3', '1,3'],
    direction: overrides.direction ?? { dx: 1, dy: 0 },
    pending: overrides.pending ?? null,
    food: 'food' in overrides ? overrides.food : '5,3',
    status: overrides.status ?? 'running',
  };
}

test('initial state is a ready snake whose food is off the snake', () => {
  const game = createGame({ width: 8, height: 8, seed: 3 });
  assert.equal(game.status, 'ready');
  assert.deepEqual(game.snake, ['4,4', '3,4', '2,4']);
  assert.equal(game.score, 0);
  assert.equal(game.ticks, 0);
  assert.equal(game.outcome, null);
  assert.ok(game.food);
  assert.equal(game.snake.includes(game.food), false);
});

test('grids smaller than 3x3 are rejected', () => {
  assert.throws(() => createGame({ width: 2, height: 2 }), RangeError);
});

test('step advances one cell without growing', () => {
  const next = step(board({ food: '0,0' }));
  assert.deepEqual(next.snake, ['4,3', '3,3', '2,3']);
  assert.equal(next.score, 0);
  assert.equal(next.ticks, 1);
  assert.equal(next.status, 'running');
});

test('eating food grows the snake and scores', () => {
  const eaten = step(board({ food: '4,3' }));
  assert.deepEqual(eaten.snake, ['4,3', '3,3', '2,3', '1,3']);
  assert.equal(eaten.score, 1);
  assert.equal(eaten.snake.includes(eaten.food), false, 'new food avoids the snake');
});

test('hitting a wall ends the game', () => {
  const over = step(board({ snake: ['5,3', '4,3', '3,3'], food: '0,0' }));
  assert.equal(over.status, 'over');
  assert.equal(over.outcome, 'wall');
  assert.equal(step(over), over, 'a finished game does not step');
});

test('hitting itself ends the game, but the vacated tail cell is safe', () => {
  const selfHit = step(board({ snake: ['3,3', '3,4', '4,4'], direction: { dx: 0, dy: 1 }, food: '0,0' }));
  assert.equal(selfHit.status, 'over');
  assert.equal(selfHit.outcome, 'self');

  const survived = step(board({ snake: ['2,3', '2,2', '1,2', '1,3'], direction: { dx: -1, dy: 0 }, food: '0,0' }));
  assert.equal(survived.status, 'running');
  assert.equal(survived.snake[0], '1,3');
});

test('reversals are refused, including one queued inside the same tick', () => {
  assert.equal(queueDirection(board(), 'left').pending, null);

  let game = board({ food: '0,0' });
  game = queueDirection(game, 'up');
  assert.deepEqual(game.pending, { dx: 0, dy: -1 });
  // 'left' would reverse the direction actually travelled this tick.
  assert.deepEqual(queueDirection(game, 'left').pending, { dx: 0, dy: -1 });

  game = step(game);
  assert.deepEqual(game.direction, { dx: 0, dy: -1 });
  assert.equal(game.pending, null);
  assert.equal(game.snake[0], '3,2');
});

test('pause freezes ticks and resume continues them', () => {
  const game = board({ food: '0,0' });
  const paused = pause(game);
  assert.equal(paused.status, 'paused');
  assert.equal(step(paused), paused);

  const playing = resume(paused);
  assert.equal(playing.status, 'running');
  assert.equal(step(playing).snake[0], '4,3');
  assert.equal(pause(playing).status, 'paused');
  assert.equal(resume(game).status, 'running');
});

test('restart resets snake, score, and ticks', () => {
  const played = queueDirection(step(board({ food: '4,3' })), 'down');
  const fresh = restart(played);
  assert.equal(fresh.snake.length, 3);
  assert.equal(fresh.score, 0);
  assert.equal(fresh.ticks, 0);
  assert.equal(fresh.pending, null);
  assert.equal(fresh.status, 'running');
});

test('start launches a ready game and ignores a finished one', () => {
  assert.equal(start(createGame({ width: 6, height: 6 })).status, 'running');
  const over = { ...board(), status: 'over' };
  assert.equal(start(over), over);
});

test('run advances many ticks and stops at game over', () => {
  const crossed = run(board({ food: '0,0' }), 2);
  assert.equal(crossed.ticks, 2);
  assert.equal(crossed.snake[0], '5,3');
  // One more tick hits the wall; the loop must stop there, not keep stepping.
  const ended = run(crossed, 5);
  assert.equal(ended.status, 'over');
  assert.equal(ended.ticks, 3);
});

test('food spawn is deterministic, skips the snake, and is bounded', () => {
  const seeds = [1, 2, 3].map(() => createGame({ width: 6, height: 6, seed: 42 }).food);
  assert.equal(new Set(seeds).size, 1, `same seed must repeat: ${seeds}`);

  const rng = createRng(5);
  const almostFull = createGame({ width: 3, height: 3, rng });
  const snake = ['0,0', '1,0', '2,0', '0,1', '1,1', '2,1', '0,2', '1,2'];
  assert.equal(placeFood({ ...almostFull, snake }), '2,2');

  const full = { ...almostFull, snake: [...snake, '2,2'] };
  assert.equal(placeFood(full), null, 'no free cell means no food');
});

test('filling the grid ends the game as a win', () => {
  const nearlyFull = board({
    width: 3,
    height: 3,
    snake: ['2,1', '2,0', '1,0', '1,1', '1,2', '0,2', '0,1', '0,0'],
    direction: { dx: 0, dy: 1 },
    food: '2,2',
  });
  const won = step(nearlyFull);
  assert.equal(won.status, 'over');
  assert.equal(won.outcome, 'win');
  assert.equal(won.score, 1);
  assert.equal(won.snake.length, 9);
  assert.equal(won.food, null);
});
