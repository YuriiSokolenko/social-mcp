// Deterministic engine tests — no DOM, no timers, no network, no Math.random.
// Run: node --test examples/workflow-smoke/pack-20261011-rerun4/snake/engine.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRID_HEIGHT,
  GRID_WIDTH,
  INITIAL_LENGTH,
  STATUS_OVER,
  STATUS_PAUSED,
  STATUS_READY,
  STATUS_RUNNING,
  allCells,
  createGame,
  createRng,
  directionVector,
  freeCells,
  key,
  parseKey,
  pause,
  placeFood,
  queueDirection,
  restart,
  resume,
  run,
  start,
  step,
} from './engine.mjs';

/** Fully controlled board: no RNG unless explicitly requested. */
function board(options = {}) {
  const width = options.width ?? 6;
  const height = options.height ?? 6;
  const snake = options.snake ?? ['2,2', '1,2', '0,2'];
  const food = 'food' in options ? options.food : '4,2';
  const nextFood = 'nextFood' in options ? options.nextFood : '5,5';
  return {
    width,
    height,
    seed: options.seed ?? 7,
    snake: [...snake],
    direction: options.direction ?? 'right',
    pending: [...(options.pending ?? [])],
    food,
    score: options.score ?? 0,
    ticks: options.ticks ?? 0,
    status: options.status ?? STATUS_RUNNING,
    outcome: options.outcome ?? null,
    placeFoodFn: options.placeFoodFn ?? (() => nextFood),
  };
}

test('createGame: initial ready state, snake centred, food off the snake', () => {
  const g = createGame({ width: 7, height: 7, seed: 3 });
  assert.equal(g.status, STATUS_READY);
  assert.equal(g.outcome, null);
  assert.equal(g.score, 0);
  assert.equal(g.ticks, 0);
  assert.equal(g.direction, 'right');
  assert.deepEqual(g.pending, []);
  assert.deepEqual(g.snake, ['3,3', '2,3', '1,3']);
  assert.ok(g.food, 'food placed');
  assert.ok(!g.snake.includes(g.food), 'food never on the snake');
  assert.equal(INITIAL_LENGTH, 3);
  assert.equal(GRID_WIDTH, 21);
  assert.equal(GRID_HEIGHT, 21);
});

test('createGame: rejects grids smaller than 3x3', () => {
  assert.throws(() => createGame({ width: 2, height: 5 }), RangeError);
  assert.throws(() => createGame({ width: 5, height: 2 }), RangeError);
  assert.throws(() => createGame({ width: 2.5, height: 5 }), RangeError);
  assert.doesNotThrow(() => createGame({ width: 3, height: 3 }));
});

test('createRng: same seed reproduces the sequence, different seeds differ', () => {
  const a = createRng(42);
  const b = createRng(42);
  const c = createRng(43);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  const seqC = [c(), c(), c()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const v of seqA) {
    assert.ok(v >= 0 && v < 1);
  }
});

test('placeFood: deterministic per seed, never on the snake, null on full grid', () => {
  const state = board({ width: 5, height: 5, snake: ['0,0', '1,0', '2,0'] });
  const first = placeFood(state, createRng(11));
  const second = placeFood(state, createRng(11));
  assert.equal(first, second);
  assert.ok(!state.snake.includes(first));
  assert.equal(freeCells(state).length, 25 - 3);

  const full = board({ width: 3, height: 3, snake: allCells(3, 3), food: null });
  assert.deepEqual(freeCells(full), []);
  assert.equal(placeFood(full, createRng(1)), null);
});

test('createGame: food lands off the snake for many seeds', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const g = createGame({ seed });
    assert.ok(!g.snake.includes(g.food), `seed ${seed}: ${g.food}`);
  }
});

test('step: moves one cell, no growth, one tick, no mutation', () => {
  const state = board({ snake: ['2,2', '1,2', '0,2'], food: '5,2' });
  const next = step(state);
  assert.deepEqual(next.snake, ['3,2', '2,2', '1,2']);
  assert.equal(next.score, 0);
  assert.equal(next.ticks, 1);
  assert.equal(next.status, STATUS_RUNNING);
  assert.equal(next.food, '5,2');
  // purity
  assert.deepEqual(state.snake, ['2,2', '1,2', '0,2']);
  assert.equal(state.ticks, 0);
  assert.notEqual(next, state);
});

test('step: eating grows the snake, scores and places new food off the snake', () => {
  const state = board({
    snake: ['2,2', '1,2', '0,2'],
    food: '3,2',
    nextFood: '5,4',
  });
  const next = step(state);
  assert.deepEqual(next.snake, ['3,2', '2,2', '1,2', '0,2']);
  assert.equal(next.score, 1);
  assert.equal(next.ticks, 1);
  assert.equal(next.food, '5,4');
  assert.ok(!next.snake.includes(next.food));
});

test('step: new food is requested with the post-move snake', () => {
  const seen = [];
  const state = board({
    snake: ['2,2', '1,2', '0,2'],
    food: '3,2',
    placeFoodFn: (s) => {
      seen.push([s.snake.length, s.score]);
      return '0,0';
    },
  });
  step(state);
  assert.deepEqual(seen, [[4, 1]], 'placement sees the grown snake');
});

test('step: wall collision ends the game with outcome wall', () => {
  const state = board({ width: 6, snake: ['5,2', '4,2', '3,2'], food: '0,0' });
  const next = step(state);
  assert.equal(next.status, STATUS_OVER);
  assert.equal(next.outcome, 'wall');
  assert.equal(next.ticks, 0, 'a losing tick is not counted');
  assert.deepEqual(next.pending, []);
});

test('step: self collision ends the game with outcome self', () => {
  const state = board({
    snake: ['2,2', '1,2', '1,1', '2,1', '3,1'],
    direction: 'up',
    food: '5,5',
  });
  const next = step(state);
  assert.equal(next.status, STATUS_OVER);
  assert.equal(next.outcome, 'self');
});

test('step: moving into the vacating tail cell is safe', () => {
  const state = board({
    snake: ['2,2', '1,2', '1,1', '2,1'],
    direction: 'up',
    food: '5,5',
  });
  const next = step(state);
  assert.equal(next.status, STATUS_RUNNING);
  assert.equal(next.snake[0], '2,1');
});

test('step: a finished game does not step again (no double scoring)', () => {
  const over = board({ status: STATUS_OVER, outcome: 'wall', score: 4, ticks: 9 });
  assert.equal(step(over), over);

  const started = start(board({ status: STATUS_READY, food: '3,2' }));
  const eaten = step(started);
  const again = step({ ...eaten, status: STATUS_OVER, outcome: 'self' });
  assert.equal(again.score, eaten.score);
  assert.equal(again.ticks, eaten.ticks);
});

test('step: paused and ready games do not advance', () => {
  const ready = createGame({ width: 6, height: 6, seed: 2 });
  assert.equal(step(ready), ready);
  const running = start(board({}));
  const paused = pause(running);
  assert.equal(paused.status, STATUS_PAUSED);
  assert.equal(step(paused), paused);
});

test('queueDirection: accepts a legal turn and rejects the 180 reversal', () => {
  const state = board({ direction: 'right' });
  const turned = queueDirection(state, 'up');
  assert.deepEqual(turned.pending, ['up']);
  assert.deepEqual(state.pending, [], 'input not mutated');

  const reversed = queueDirection(state, 'left');
  assert.equal(reversed, state, 'immediate 180 reversal is ignored');

  const reversedAfterTurn = queueDirection(queueDirection(state, 'up'), 'down');
  assert.deepEqual(reversedAfterTurn.pending, ['up'], 'second queued 180 ignored');

  assert.equal(queueDirection(state, null), state);
  assert.equal(queueDirection(state, 'diagonal'), state);
  assert.equal(queueDirection(state, 'right'), state, 'same direction is a no-op');

  const buffered = queueDirection(queueDirection(queueDirection(state, 'up'), 'left'), 'up');
  assert.deepEqual(buffered.pending, ['up', 'left'], 'buffer is bounded');
});

test('queueDirection: reversal is rejected at game start and while paused', () => {
  const ready = createGame({ width: 6, height: 6, seed: 5 });
  assert.equal(ready.direction, 'right');
  assert.equal(queueDirection(ready, 'left'), ready);
  assert.deepEqual(queueDirection(ready, 'down').pending, ['down']);

  const paused = pause(start(board({ direction: 'right' })));
  assert.equal(queueDirection(paused, 'left'), paused);
  assert.deepEqual(queueDirection(paused, 'up').pending, ['up']);
});

test('queueDirection: queued turns apply one tick at a time', () => {
  let state = board({ snake: ['2,2', '1,2', '0,2'], food: '5,5' });
  state = queueDirection(state, 'up');
  state = queueDirection(state, 'left');
  state = step(state);
  assert.equal(state.direction, 'up');
  assert.equal(state.snake[0], '2,1');
  state = step(state);
  assert.equal(state.direction, 'left');
  assert.equal(state.snake[0], '1,1');
  assert.deepEqual(state.pending, []);
});

test('queueDirection: a reversal queued after a turn applies on the next tick', () => {
  let state = board({ snake: ['2,2', '1,2', '0,2'], food: '5,5' });
  state = queueDirection(state, 'up');
  state = queueDirection(state, 'right');
  state = step(state);
  state = step(state);
  assert.equal(state.status, STATUS_RUNNING);
  assert.equal(state.direction, 'right');
});

test('start / pause / resume transitions', () => {
  const ready = createGame({ width: 6, height: 6, seed: 4 });
  const running = start(ready);
  assert.equal(running.status, STATUS_RUNNING);
  assert.equal(start(running), running, 'start is idempotent');

  const paused = pause(running);
  assert.equal(paused.status, STATUS_PAUSED);
  assert.equal(pause(paused), paused, 'pause is idempotent');

  const resumed = resume(paused);
  assert.equal(resumed.status, STATUS_RUNNING);
  assert.equal(resumed.ticks, 0, 'pause does not advance the game');

  const over = { ...running, status: STATUS_OVER, outcome: 'wall' };
  assert.equal(start(over), over, 'a finished game cannot start');
  assert.equal(pause(over), over);
  assert.equal(resume(over), over);
});

test('restart returns a fresh ready board and resets the score', () => {
  const played = board({ snake: ['2,2', '1,2', '0,2'], score: 7, ticks: 12, status: STATUS_OVER, outcome: 'wall' });
  const fresh = restart(played);
  assert.equal(fresh.status, STATUS_READY);
  assert.equal(fresh.score, 0);
  assert.equal(fresh.ticks, 0);
  assert.equal(fresh.outcome, null);
  assert.deepEqual(fresh.pending, []);
  assert.equal(fresh.width, played.width);
  assert.equal(fresh.height, played.height);
  assert.equal(fresh.seed, played.seed);
  assert.deepEqual(fresh.snake, ['3,3', '2,3', '1,3']);
  assert.ok(!fresh.snake.includes(fresh.food));

  // Playable again after restart.
  const next = step(start(fresh));
  assert.equal(next.ticks, 1);
});

test('run: applies exactly N ticks', () => {
  const state = start(board({ snake: ['2,2', '1,2', '0,2'], food: '5,5' }));
  const after = run(state, 3);
  assert.equal(after.ticks, 3);
  assert.equal(after.snake[0], '5,2');
  assert.equal(run(state, 0), state);

  const intoWall = run(state, 10);
  assert.equal(intoWall.status, STATUS_OVER);
  assert.equal(intoWall.outcome, 'wall');
  assert.equal(intoWall.ticks, 3, 'stops at the wall, no extra ticks');
});

test('full grid: eating the last free cell wins and leaves no food', () => {
  const snake = ['2,1', '2,0', '1,0', '0,0', '0,1', '1,1', '1,2', '0,2'];
  const state = board({
    width: 3,
    height: 3,
    snake,
    direction: 'down',
    food: '2,2',
    placeFoodFn: () => null,
  });
  assert.deepEqual(freeCells(state), ['2,2']);
  const next = step(state);
  assert.equal(next.status, STATUS_OVER);
  assert.equal(next.outcome, 'win');
  assert.equal(next.food, null);
  assert.equal(next.score, 1);
  assert.equal(next.snake.length, 9);
  assert.deepEqual(freeCells(next), []);
});

test('bounded spawn: placeFoodFn returning null ends the game as a win', () => {
  const state = board({
    width: 3,
    height: 3,
    snake: ['1,1', '0,1'],
    direction: 'right',
    food: '2,1',
    placeFoodFn: () => null,
  });
  const next = step(state);
  assert.equal(next.outcome, 'win');
  assert.equal(next.status, STATUS_OVER);
  assert.equal(next.snake.length, 3);
});

test('key / parseKey / directionVector helpers round-trip', () => {
  assert.equal(key(4, 7), '4,7');
  assert.deepEqual(parseKey('4,7'), { x: 4, y: 7 });
  assert.deepEqual(directionVector('up'), { dx: 0, dy: -1 });
  assert.deepEqual(directionVector({ dx: -1, dy: 0 }), { dx: -1, dy: 0 });
  assert.equal(directionVector('nowhere'), null);
  assert.equal(directionVector(null), null);
});

test('determinism: identical seeds and inputs produce identical games', () => {
  const play = (seed) => {
    let state = start(createGame({ width: 8, height: 8, seed }));
    const shots = [];
    for (let i = 0; i < 12; i += 1) {
      if (i === 3) state = queueDirection(state, 'down');
      if (i === 7) state = queueDirection(state, 'left');
      state = step(state);
      shots.push([state.snake.join('|'), state.food, state.score, state.status]);
    }
    return shots;
  };
  assert.deepEqual(play(99), play(99));
});
