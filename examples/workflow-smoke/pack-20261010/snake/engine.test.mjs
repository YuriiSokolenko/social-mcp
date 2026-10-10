import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame,
  createRng,
  placeFood,
  queueDirection,
  start,
  pause,
  resume,
  restart,
  run,
  step,
  isOver,
  key,
  parseKey,
} from './engine.mjs';

/** Small explicit board so each test controls the whole grid. */
function board(overrides = {}) {
  const base = createGame({ width: 6, height: 6, length: 3, seed: 7 });
  return { ...base, status: 'running', ...overrides };
}

test('initial state is ready with a centred snake and off-snake food', () => {
  const game = createGame({ width: 7, height: 7, seed: 42 });
  assert.equal(game.status, 'ready');
  assert.equal(game.score, 0);
  assert.equal(game.ticks, 0);
  assert.equal(game.outcome, null);
  assert.deepEqual(game.snake, [key(3, 3), key(2, 3), key(1, 3)]);
  assert.equal(game.direction, 'right');
  assert.equal(game.pending, null);
  assert.ok(game.food, 'food placed');
  assert.ok(!game.snake.includes(game.food));
});

test('createGame rejects grids smaller than 3x3', () => {
  assert.throws(() => createGame({ width: 2, height: 5 }), RangeError);
  assert.throws(() => createGame({ width: 5, height: 2 }), RangeError);
});

test('plain movement advances one cell with no growth', () => {
  const state = board({ snake: [key(2, 2), key(1, 2), key(0, 2)], direction: 'right', food: key(5, 5) });
  const next = step(state);
  assert.deepEqual(next.snake, [key(3, 2), key(2, 2), key(1, 2)]);
  assert.equal(next.score, 0);
  assert.equal(next.ticks, 1);
  assert.equal(next.status, 'running');
  assert.equal(next.food, key(5, 5));
});

test('eating grows the snake, scores, and replaces food off the snake', () => {
  const state = board({
    snake: [key(2, 2), key(1, 2), key(0, 2)],
    direction: 'right',
    food: key(3, 2),
    foodFactory: () => key(0, 0),
  });
  const next = step(state);
  assert.deepEqual(next.snake, [key(3, 2), key(2, 2), key(1, 2), key(0, 2)]);
  assert.equal(next.score, 1);
  assert.equal(next.food, key(0, 0));
});

test('replaced food never lands on the snake', () => {
  const state = board({
    snake: [key(2, 2), key(1, 2), key(0, 2)],
    direction: 'right',
    food: key(3, 2),
  });
  const next = step(state);
  assert.ok(next.food);
  assert.ok(!next.snake.includes(next.food));
});

test('wall collision ends the game with outcome wall', () => {
  const state = board({ snake: [key(5, 1), key(4, 1), key(3, 1)], direction: 'right', food: key(0, 0) });
  const next = step(state);
  assert.equal(next.status, 'over');
  assert.equal(next.outcome, 'wall');
  assert.equal(isOver(next), true);
  assert.ok(isOver(next) && step(next) === next, 'stepping a finished game is a no-op');
});

test('self collision ends the game with outcome self', () => {
  const state = board({
    snake: [key(3, 3), key(4, 3), key(4, 4), key(3, 4), key(2, 4), key(2, 3)],
    direction: 'left',
    pending: 'down',
    food: key(0, 0),
  });
  const next = step(state);
  assert.equal(next.status, 'over');
  assert.equal(next.outcome, 'self');
});

test('moving into the cell the tail just vacated is legal', () => {
  const state = board({
    snake: [key(3, 3), key(4, 3), key(4, 4), key(3, 4)],
    direction: 'left',
    pending: 'down',
    food: key(0, 0),
  });
  const next = step(state);
  assert.equal(next.status, 'running');
  assert.equal(next.outcome, null);
  assert.deepEqual(next.snake, [key(3, 4), key(3, 3), key(4, 3), key(4, 4)]);
});

test('immediate 180-degree reversal is refused', () => {
  const state = board({ snake: [key(2, 2), key(1, 2), key(0, 2)], direction: 'right', food: key(5, 5) });
  assert.equal(queueDirection(state, 'left'), state);
  const turned = queueDirection(state, 'up');
  assert.equal(turned.pending, 'up');
});

test('a direction queued twice inside one tick cannot reverse the snake', () => {
  const state = board({ snake: [key(2, 2), key(1, 2), key(0, 2)], direction: 'right', food: key(5, 5) });
  const twice = queueDirection(queueDirection(state, 'up'), 'down');
  assert.equal(twice.pending, 'up');
  const next = step(twice);
  assert.equal(next.direction, 'up');
  assert.deepEqual(next.snake, [key(2, 1), key(2, 2), key(1, 2)]);
});

test('queueDirection ignores unknown directions and finished games', () => {
  const state = board({});
  assert.equal(queueDirection(state, 'sideways'), state);
  const over = { ...state, status: 'over', outcome: 'wall' };
  assert.equal(queueDirection(over, 'up'), over);
});

test('pause freezes ticks and blocks step; resume continues', () => {
  const state = board({ snake: [key(2, 2), key(1, 2), key(0, 2)], direction: 'right', food: key(5, 5) });
  const paused = pause(state);
  assert.equal(paused.status, 'paused');
  assert.equal(step(paused), paused);
  const resumed = resume(paused);
  assert.equal(resumed.status, 'running');
  const next = step(resumed);
  assert.equal(next.ticks, 1);
  assert.deepEqual(next.snake, [key(3, 2), key(2, 2), key(1, 2)]);
});

test('pause on a non-running game and resume on a running game are no-ops', () => {
  const running = board({});
  assert.equal(pause(running) !== running, true);
  assert.equal(resume(running), running);
  const ready = createGame({ width: 5, height: 5, seed: 3 });
  assert.equal(pause(ready), ready);
  assert.equal(resume(ready), ready);
});

test('restart rebuilds a fresh running game', () => {
  const state = board({
    snake: [key(5, 5), key(4, 5), key(3, 5)],
    direction: 'left',
    pending: 'up',
    food: key(0, 0),
    score: 9,
    ticks: 12,
  });
  const fresh = restart(state);
  assert.equal(fresh.status, 'running');
  assert.equal(fresh.score, 0);
  assert.equal(fresh.ticks, 0);
  assert.equal(fresh.pending, null);
  assert.equal(fresh.snake.length, 3);
  assert.equal(fresh.outcome, null);
});

test('start launches a ready game and ignores a finished one', () => {
  const ready = createGame({ width: 5, height: 5, seed: 5 });
  assert.equal(start(ready).status, 'running');
  const over = { ...board({}), status: 'over', outcome: 'self' };
  assert.equal(start(over), over);
});

test('run advances n ticks and stops at game over', () => {
  const state = board({ snake: [key(2, 2), key(1, 2), key(0, 2)], direction: 'right', food: key(0, 5) });
  const three = run(state, 3);
  assert.equal(three.ticks, 3);
  assert.deepEqual(three.snake, [key(5, 2), key(4, 2), key(3, 2)]);
  // Next step hits the right-hand wall.
  const stopped = run(state, 4);
  assert.equal(stopped.status, 'over');
  assert.equal(stopped.outcome, 'wall');
  assert.equal(stopped.ticks, 3);
});

test('food placement is deterministic for a given seed', () => {
  const a = createGame({ width: 9, height: 9, seed: 1234 });
  const b = createGame({ width: 9, height: 9, seed: 1234 });
  assert.equal(a.food, b.food);
  const rngA = createRng(99);
  const rngB = createRng(99);
  assert.deepEqual([rngA(), rngA(), rngA()], [rngB(), rngB(), rngB()]);
});

test('near-full board places food on the single free cell', () => {
  const state = board({
    width: 3,
    height: 3,
    snake: [key(1, 0), key(0, 0), key(0, 1), key(1, 1), key(2, 1), key(2, 0), key(2, 2), key(1, 2)],
    direction: 'left',
    food: key(0, 2),
  });
  assert.equal(placeFood(state), key(0, 2));
});

test('full board yields no food', () => {
  const state = board({
    width: 3,
    height: 3,
    snake: [key(0, 0), key(1, 0), key(2, 0), key(0, 1), key(1, 1), key(2, 1), key(0, 2), key(1, 2), key(2, 2)],
    direction: 'left',
    food: key(0, 0),
  });
  assert.equal(placeFood(state), null);
});

test('filling the board by eating wins with food null', () => {
  const state = board({
    width: 3,
    height: 3,
    snake: [key(2, 1), key(2, 2), key(1, 2), key(0, 2), key(0, 1), key(1, 1), key(1, 0), key(0, 0)],
    direction: 'up',
    food: key(2, 0),
  });
  const next = step(state);
  assert.equal(next.status, 'over');
  assert.equal(next.outcome, 'win');
  assert.equal(next.food, null);
  assert.equal(next.score, 1);
  assert.equal(next.snake.length, 9);
});

test('key and parseKey round-trip', () => {
  assert.equal(key(4, 5), '4,5');
  assert.deepEqual(parseKey(key(4, 5)), { x: 4, y: 5 });
});
