import test from "node:test";
import assert from "node:assert/strict";

import {
  DIRECTIONS,
  GRID_HEIGHT,
  GRID_WIDTH,
  INITIAL_LENGTH,
  key,
  parseKey,
  createRng,
  placeFood,
  createGame,
  isOver,
  queueDirection,
  start,
  pause,
  resume,
  restart,
  step,
  run,
  parseKeyInput,
} from "./engine.mjs";

/** Deterministic small board with explicit state for rule tests. */
function board(overrides = {}) {
  const base = createGame({ width: 6, height: 6, seed: 7 });
  return { ...base, status: "running", ...overrides };
}

test("initial state is ready, centred, and food-free of the snake", () => {
  const state = createGame({ width: 10, height: 10, seed: 42 });
  assert.equal(state.status, "ready");
  assert.equal(state.outcome, null);
  assert.equal(state.score, 0);
  assert.equal(state.ticks, 0);
  assert.equal(state.direction, "right");
  assert.equal(state.pending, null);
  assert.equal(state.snake.length, INITIAL_LENGTH);
  assert.deepEqual(state.snake, ["6,5", "5,5", "4,5"]);
  assert.ok(state.food, "food placed");
  assert.ok(!state.snake.includes(state.food), "food not on snake");
});

test("default grid matches advertised constants", () => {
  const state = createGame();
  assert.equal(state.width, GRID_WIDTH);
  assert.equal(state.height, GRID_HEIGHT);
});

test("invalid grid sizes are rejected", () => {
  assert.throws(() => createGame({ width: 2 }), RangeError);
  assert.throws(() => createGame({ height: 2 }), RangeError);
  assert.throws(() => createGame({ width: 4.5 }), RangeError);
});

test("step moves one cell with no growth and ticks++", () => {
  const state = board({
    snake: ["3,3", "2,3", "1,3"],
    direction: "right",
    pending: null,
    food: "0,0",
  });
  const next = step(state);
  assert.equal(next.snake[0], "4,3");
  assert.deepEqual(next.snake, ["4,3", "3,3", "2,3"]);
  assert.equal(next.snake.length, 3);
  assert.equal(next.score, 0);
  assert.equal(next.ticks, state.ticks + 1);
  assert.equal(next.food, "0,0");
  assert.equal(next.status, "running");
});

test("eating grows by one, scores, and relocates food off the snake", () => {
  const state = board({
    snake: ["4,3", "3,3", "2,3"],
    direction: "right",
    pending: null,
    food: "5,3",
  });
  const next = step(state);
  assert.deepEqual(next.snake, ["5,3", "4,3", "3,3", "2,3"]);
  assert.equal(next.score, 1);
  assert.equal(next.ticks, 1);
  assert.ok(next.food);
  assert.ok(!next.snake.includes(next.food));
});

test("wall collision ends the game and freezing blocks stepping", () => {
  const state = board({ snake: ["5,3", "4,3", "3,3"], direction: "right", pending: null });
  const over = step(state);
  assert.equal(over.status, "over");
  assert.equal(over.outcome, "wall");
  assert.equal(isOver(over), true);
  assert.equal(step(over), over);
});

test("self collision ends the game; the vacated tail cell is safe", () => {
  const state = board({
    snake: ["3,3", "3,2", "2,2", "1,2", "1,3", "2,3", "2,4"],
    direction: "left",
    pending: null,
    food: "0,0",
  });
  const over = step(state);
  assert.equal(over.status, "over");
  assert.equal(over.outcome, "self");

  const tailChase = board({
    snake: ["3,3", "3,2", "4,2", "4,3"],
    direction: "right",
    pending: null,
    food: "0,0",
  });
  const moved = step(tailChase);
  assert.equal(moved.status, "running");
  assert.equal(moved.snake[0], "4,3");
});

test("direction: straight repeat and immediate reversal are refused", () => {
  const state = board({ snake: ["3,3", "2,3", "1,3"], direction: "right", pending: null });
  assert.equal(queueDirection(state, "right"), state);
  assert.equal(queueDirection(state, "left"), state);

  const up = queueDirection(state, "up");
  assert.notEqual(up, state);
  assert.equal(up.pending, "up");
  // Second press inside the same tick cannot reverse current heading.
  assert.equal(queueDirection(up, "down"), up);
  assert.equal(queueDirection(up, "up"), up);
});

test("pending heading is applied and cleared by the next step", () => {
  const state = board({ snake: ["3,3", "2,3", "1,3"], direction: "right", pending: null });
  const turned = queueDirection(state, "up");
  const next = step(turned);
  assert.equal(next.direction, "up");
  assert.equal(next.pending, null);
  assert.equal(next.snake[0], "3,2");
});

test("pause freezes the game; resume continues; resume while running is a no-op", () => {
  const running = board({ snake: ["3,3", "2,3", "1,3"], direction: "right", pending: null });
  const paused = pause(running);
  assert.equal(paused.status, "paused");
  assert.equal(step(paused), paused);
  assert.equal(queueDirection(paused, "up"), paused);

  const resumed = resume(paused);
  assert.equal(resumed.status, "running");
  assert.equal(resume(running), running);
  assert.equal(pause(paused), paused);
  assert.equal(step(resumed).ticks, running.ticks + 1);
});

test("restart returns a fresh running game", () => {
  const over = step(
    board({ snake: ["5,3", "4,3", "3,3"], direction: "right", pending: null }),
  );
  assert.equal(over.status, "over");
  const fresh = restart(over);
  assert.equal(fresh.status, "running");
  assert.equal(fresh.score, 0);
  assert.equal(fresh.ticks, 0);
  assert.equal(fresh.pending, null);
  assert.equal(fresh.snake.length, INITIAL_LENGTH);
  assert.equal(fresh.outcome, null);
});

test("start launches a ready board and ignores a finished one", () => {
  const ready = createGame({ width: 5, height: 5, seed: 11 });
  assert.equal(start(ready).status, "running");
  const over = { ...ready, status: "over", outcome: "wall" };
  assert.equal(start(over), over);
});

test("run advances n ticks and stops at game over", () => {
  const state = board({ snake: ["3,3", "2,3", "1,3"], direction: "right", pending: null });
  const advanced = run(state, 2);
  assert.equal(advanced.ticks, 2);
  assert.equal(advanced.snake[0], "5,3");

  const crashed = run(state, 50);
  assert.equal(crashed.status, "over");
  assert.equal(crashed.outcome, "wall");
  assert.equal(crashed.ticks, 2);
  assert.equal(run(state, 0), state);
});

test("food spawn is seed-deterministic, bounded, and skips occupied cells", () => {
  const a = createGame({ width: 5, height: 5, seed: 123 });
  const b = createGame({ width: 5, height: 5, seed: 123 });
  assert.equal(a.food, b.food);

  const placements = new Set();
  for (let seed = 1; seed <= 20; seed += 1) {
    const game = createGame({ width: 5, height: 5, seed });
    assert.ok(!game.snake.includes(game.food));
    placements.add(game.food);
  }
  assert.ok(placements.size > 1, "seed drives the placement");

  const rng = createRng(5);
  assert.ok(typeof rng() === "number");

  const almostFull = board({
    width: 3,
    height: 3,
    snake: ["0,0", "1,0", "2,0", "0,1", "1,1", "2,1", "0,2", "1,2"],
  });
  assert.equal(placeFood(almostFull, { seed: 1 }), "2,2");

  const full = board({
    width: 3,
    height: 3,
    snake: ["0,0", "1,0", "2,0", "0,1", "1,1", "2,1", "0,2", "1,2", "2,2"],
  });
  assert.equal(placeFood(full, { seed: 1 }), null);
});

test("eating the last free cell wins", () => {
  const state = board({
    width: 3,
    height: 3,
    snake: ["1,2", "0,2", "0,1", "1,1", "2,1", "2,0", "1,0", "0,0"],
    direction: "right",
    pending: null,
    food: "2,2",
  });
  const won = step(state);
  assert.equal(won.status, "over");
  assert.equal(won.outcome, "win");
  assert.equal(won.food, null);
  assert.equal(won.score, 1);
  assert.equal(won.snake.length, 9);
});

test("key/parseKey round-trip and direction table", () => {
  assert.equal(key(2, 3), "2,3");
  assert.deepEqual(parseKey("2,3"), { x: 2, y: 3 });
  assert.deepEqual(DIRECTIONS.up, { x: 0, y: -1 });
});

test("parseKeyInput maps arrows and WASD", () => {
  assert.equal(parseKeyInput("ArrowUp"), "up");
  assert.equal(parseKeyInput("ArrowDown"), "down");
  assert.equal(parseKeyInput("ArrowLeft"), "left");
  assert.equal(parseKeyInput("ArrowRight"), "right");
  assert.equal(parseKeyInput("w"), "up");
  assert.equal(parseKeyInput("A"), "left");
  assert.equal(parseKeyInput("s"), "down");
  assert.equal(parseKeyInput("d"), "right");
  assert.equal(parseKeyInput("space"), null);
  assert.equal(parseKeyInput(null), null);
});