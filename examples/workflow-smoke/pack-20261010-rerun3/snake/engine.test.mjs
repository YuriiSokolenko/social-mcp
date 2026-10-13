// Node-only suite for the pack-20261010-rerun3 Snake engine.
//
// Run: node --test examples/workflow-smoke/pack-20261010-rerun3/snake/engine.test.mjs
// Every case pins the grid, the snake, and food placement: no DOM, timers,
// randomness, or network.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLS,
  DIRECTIONS,
  ROWS,
  START_LENGTH,
  createGame,
  createRng,
  isOver,
  pause,
  placeFood,
  queueDirection,
  restart,
  resume,
  run,
  start,
  step,
} from './engine.mjs';

/** Running 7x7 board with pinned food, ready for a transition to act on. */
function board(overrides = {}) {
  const options = { width: 7, height: 7, seed: 7, placeFood: () => '5,5', ...overrides.options };
  return { ...createGame(options), status: 'running', ...overrides };
}

test('createGame builds a centred ready board with food off the snake', () => {
  const game = createGame({ width: 9, height: 9, seed: 3 });
  assert.equal(game.width, 9);
  assert.equal(game.status, 'ready');
  assert.equal(game.outcome, null);
  assert.equal(game.score, 0);
  assert.equal(game.ticks, 0);
  assert.equal(game.pending, null);
  assert.equal(game.snake.length, START_LENGTH);
  assert.deepEqual(game.snake, ['4,4', '3,4', '2,4']);
  assert.deepEqual(game.direction, DIRECTIONS.right);
  assert.ok(game.food && !game.snake.includes(game.food));
});

test('createGame defaults to the documented grid and validates sizes', () => {
  const game = createGame({ seed: 11 });
  assert.equal(game.width, COLS);
  assert.equal(game.height, ROWS);
  assert.throws(() => createGame({ width: 2 }), RangeError);
  assert.throws(() => createGame({ height: 2 }), RangeError);
  assert.throws(() => createGame({ width: 4.5, height: 5 }), RangeError);
});

test('step moves one cell without growing or scoring', () => {
  const state = board({ snake: ['3,3', '2,3', '1,3'], food: '6,0' });
  const next = step(state);
  assert.deepEqual(next.snake, ['4,3', '3,3', '2,3']);
  assert.equal(next.score, 0);
  assert.equal(next.ticks, 1);
  assert.equal(next.status, 'running');
  assert.equal(next.food, '6,0');
});

test('eating grows the snake, scores, and respawns food off the body', () => {
  const state = board({
    snake: ['3,3', '2,3', '1,3'],
    food: '4,3',
    options: { width: 7, height: 7, seed: 2, placeFood: () => '0,6' },
  });
  const next = step(state);
  assert.deepEqual(next.snake, ['4,3', '3,3', '2,3', '1,3']);
  assert.equal(next.score, 1);
  assert.equal(next.ticks, 1);
  assert.equal(next.food, '0,6');
  assert.equal(next.status, 'running');
});

test('queueDirection turns apply once and clear pending', () => {
  const state = board({ snake: ['3,3', '2,3', '1,3'], food: '6,6' });
  const queued = queueDirection(state, 'up');
  assert.deepEqual(queued.pending, DIRECTIONS.up);
  const moved = step(queued);
  assert.deepEqual(moved.snake, ['3,2', '3,3', '2,3']);
  assert.deepEqual(moved.direction, DIRECTIONS.up);
  assert.equal(moved.pending, null);
});

test('queueDirection refuses an immediate 180 degree reversal', () => {
  const state = board();
  assert.equal(queueDirection(state, 'left'), state);
  assert.equal(queueDirection(state, { dx: -1, dy: 0 }), state);
  assert.equal(queueDirection(state, 'right'), state);
});

test('queueDirection refuses reversal after a turn queued in the same tick', () => {
  const up = queueDirection(board(), 'up');
  assert.deepEqual(queueDirection(up, 'down').pending, DIRECTIONS.up);
});

test('queueDirection ignores malformed input and a finished board', () => {
  const state = board();
  assert.equal(queueDirection(state, 'sideways'), state);
  assert.equal(queueDirection(state, { dx: 'x', dy: 0 }), state);
  assert.equal(queueDirection(state, null), state);
  const over = { ...state, status: 'over' };
  assert.equal(queueDirection(over, 'up'), over);
});

test('hitting a wall ends the game and a finished board cannot be stepped', () => {
  const state = board({ snake: ['6,3', '5,3', '4,3'], food: '0,0' });
  const next = step(state);
  assert.equal(next.status, 'over');
  assert.equal(next.outcome, 'wall');
  assert.ok(isOver(next));
  assert.equal(step(next), next);
  assert.equal(run(next, 5), next);
});

test('biting the body ends the game while the vacated tail cell is safe', () => {
  const selfHit = board({
    snake: ['3,3', '4,3', '4,4', '3,4', '2,4'],
    direction: { ...DIRECTIONS.left },
    food: '6,6',
  });
  const bitten = step(queueDirection(selfHit, 'down'));
  assert.equal(bitten.status, 'over');
  assert.equal(bitten.outcome, 'self');

  // Same loop, one cell shorter: the head enters the cell the tail vacates.
  const tailChase = board({
    snake: ['3,3', '4,3', '4,4', '3,4'],
    direction: { ...DIRECTIONS.left },
    food: '6,6',
  });
  const survived = step(queueDirection(tailChase, 'down'));
  assert.equal(survived.status, 'running');
  assert.equal(survived.outcome, null);
  assert.deepEqual(survived.snake, ['3,4', '3,3', '4,3', '4,4']);
});

test('step is inert until the board runs, pauses on demand, and resumes', () => {
  const ready = createGame({ width: 6, height: 6, seed: 5 });
  assert.equal(step(ready), ready);
  const running = start(ready);
  assert.equal(running.status, 'running');
  const paused = pause(running);
  assert.equal(paused.status, 'paused');
  assert.equal(step(paused), paused);
  assert.equal(pause(paused), paused);
  assert.equal(resume(ready), ready);
  const resumed = resume(paused);
  assert.equal(resumed.status, 'running');
  assert.notEqual(step(resumed), resumed);
});

test('start launches a ready board and never revives a finished one', () => {
  const ready = createGame({ width: 6, height: 6, seed: 9 });
  assert.equal(start(ready).status, 'running');
  const over = { ...ready, status: 'over', outcome: 'wall' };
  assert.equal(start(over), over);
});

test('run advances the requested ticks and stops at game over', () => {
  const state = board({ snake: ['3,3', '2,3', '1,3'], food: '0,0' });
  const advanced = run(state, 2);
  assert.deepEqual(advanced.snake, ['5,3', '4,3', '3,3']);
  assert.equal(advanced.ticks, 2);
  const crashed = run(state, 10);
  assert.equal(crashed.status, 'over');
  assert.equal(crashed.outcome, 'wall');
  assert.equal(crashed.ticks, 4);
  assert.deepEqual(crashed.snake, ['6,3', '5,3', '4,3']);
});

test('restart rebuilds the board and keeps the injected grid and seams', () => {
  const played = run(board({ score: 4, ticks: 9, pending: { ...DIRECTIONS.up } }), 1);
  const fresh = restart(played);
  assert.equal(fresh.status, 'running');
  assert.equal(fresh.score, 0);
  assert.equal(fresh.ticks, 0);
  assert.equal(fresh.pending, null);
  assert.equal(fresh.outcome, null);
  assert.equal(fresh.width, 7);
  assert.deepEqual(fresh.snake, ['3,3', '2,3', '1,3']);
  assert.equal(fresh.food, '5,5');
});

test('placeFood is seed-deterministic, skips the snake, and stays bounded', () => {
  const snake = ['0,0', '1,0', '2,0', '0,1', '1,1', '2,1', '1,2'];
  const state = { width: 3, height: 3, snake, rng: createRng(42) };
  const first = placeFood(state);
  assert.equal(first, '2,2');
  assert.equal(placeFood({ ...state, rng: createRng(42) }), first);
  assert.ok(!snake.includes(first));
  const full = { width: 2, height: 2, snake: ['0,0', '1,0', '0,1', '1,1'], rng: createRng(1) };
  assert.equal(placeFood(full), null);
});

test('eating the last free cell wins instead of spinning on food placement', () => {
  const state = {
    width: 3,
    height: 3,
    // Eight cells of the 3x3 grid, head adjacent to the last free cell.
    snake: ['2,1', '2,0', '1,0', '0,0', '0,1', '1,1', '1,2', '0,2'],
    direction: { ...DIRECTIONS.down },
    pending: null,
    food: '2,2',
    score: 0,
    ticks: 0,
    status: 'running',
    outcome: null,
    rng: createRng(1),
    foodFactory: placeFood,
    options: { width: 3, height: 3 },
  };
  const next = step(state);
  assert.equal(next.status, 'over');
  assert.equal(next.outcome, 'win');
  assert.equal(next.food, null);
  assert.equal(next.score, 1);
  assert.equal(next.snake.length, 9);
});
