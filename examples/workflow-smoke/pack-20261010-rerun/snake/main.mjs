/**
 * Browser layer for the pack-20261010-rerun Snake example.
 *
 * Everything here is DOM, canvas, or timing. All rules live in engine.mjs so
 * they stay testable with `node --test` and no browser globals.
 */
import {
  GRID_HEIGHT,
  GRID_WIDTH,
  createGame,
  parseKey,
  parseKeyInput,
  pause,
  queueDirection,
  restart,
  resume,
  start,
  step,
} from "./engine.mjs";

const STEP_MS = 130;
const MIN_CELL = 8;

const canvas = document.querySelector("#board");
const scoreOut = document.querySelector("#score");
const statusOut = document.querySelector("#status");
const startButton = document.querySelector("#start");
const pauseButton = document.querySelector("#pause");
const restartButton = document.querySelector("#restart");

const ctx = canvas.getContext("2d");
let state = createGame({
  width: GRID_WIDTH,
  height: GRID_HEIGHT,
  seed: (Date.now() >>> 0) || 1,
});
let cell = MIN_CELL;
let accumulator = 0;
let lastFrame = 0;

/**
 * Size the drawing buffer from the CSS width and the device pixel ratio, then
 * draw in grid units so the transform handles scaling.
 */
function resize() {
  const ratio = window.devicePixelRatio || 1;
  const available = canvas.clientWidth || state.width * MIN_CELL;
  cell = Math.max(MIN_CELL, Math.floor(available / state.width));
  const cssWidth = cell * state.width;
  const cssHeight = cell * state.height;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  ctx.setTransform(canvas.width / cssWidth, 0, 0, canvas.height / cssHeight, 0, 0);
}

function drawCell(cellKey, colour) {
  const { x, y } = parseKey(cellKey);
  ctx.fillStyle = colour;
  ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
}

function describe() {
  if (state.status === "over") {
    if (state.outcome === "win") return "Board full — you win. Press restart.";
    if (state.outcome === "self") return "You ran into yourself. Press restart.";
    return "You hit the wall. Press restart.";
  }
  if (state.status === "paused") return "Paused.";
  if (state.status === "ready") return "Press start, then use arrow keys or WASD.";
  return "Running.";
}

function render() {
  ctx.fillStyle = "#10161f";
  ctx.fillRect(0, 0, cell * state.width, cell * state.height);
  if (state.food) drawCell(state.food, "#e5a13c");
  const last = state.snake.length - 1;
  state.snake.forEach((segment, index) => {
    drawCell(segment, index === 0 ? "#8ede8b" : index === last ? "#2f7d3a" : "#46a254");
  });

  scoreOut.textContent = String(state.score);
  statusOut.textContent = describe();
  startButton.disabled = state.status !== "ready";
  pauseButton.disabled = state.status !== "running" && state.status !== "paused";
  pauseButton.textContent = state.status === "paused" ? "Resume" : "Pause";
  restartButton.disabled = state.status === "ready";
  canvas.setAttribute("aria-label", `Snake board, score ${state.score}. ${describe()}`);
}

function commit(next) {
  if (next !== state) {
    state = next;
    render();
  }
}

function pressDirection(direction) {
  if (state.status === "ready") commit(start(state));
  else if (state.status === "paused") commit(resume(state));
  commit(queueDirection(state, direction));
}

function onKey(event) {
  const direction = parseKeyInput(event.key);
  if (!direction) return;
  const wasRunning = state.status === "running";
  pressDirection(direction);
  // Arrows also scroll the page: only swallow them while already playing, so
  // the first press on a ready board starts the game without hijacking scroll.
  if (wasRunning) event.preventDefault();
}

function bind() {
  startButton.addEventListener("click", () => commit(start(state)));
  pauseButton.addEventListener("click", () => {
    commit(state.status === "paused" ? resume(state) : pause(state));
  });
  restartButton.addEventListener("click", () => {
    accumulator = 0;
    commit(restart(state));
  });

  document.addEventListener("keydown", onKey);
  canvas.addEventListener("pointerdown", () => {
    if (state.status === "running") commit(pause(state));
    else if (state.status !== "over") commit(start(state));
  });

  for (const button of document.querySelectorAll("[data-direction]")) {
    button.addEventListener("click", () => pressDirection(button.dataset.direction));
  }

  window.addEventListener("resize", () => {
    resize();
    render();
  });
}

/** One requestAnimationFrame per frame, one engine step per fixed STEP_MS. */
function frame(now) {
  if (!lastFrame) lastFrame = now;
  accumulator += now - lastFrame;
  lastFrame = now;
  let advanced = false;
  while (accumulator >= STEP_MS && state.status === "running") {
    accumulator -= STEP_MS;
    state = step(state);
    advanced = true;
  }
  // A backgrounded tab must not burst-fire stored steps on the next frame.
  if (accumulator > STEP_MS * 4) accumulator = 0;
  if (advanced) render();
  window.requestAnimationFrame(frame);
}

resize();
bind();
render();
window.requestAnimationFrame(frame);
