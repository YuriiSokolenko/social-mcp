// Browser layer: rendering, input, and the fixed-timestep loop. All game
// rules live in engine.mjs so they stay testable without a DOM.
import {
  GRID_HEIGHT,
  GRID_WIDTH,
  createGame,
  pause,
  queueDirection,
  restart,
  resume,
  start,
  step,
} from './engine.mjs';

const CELL = 20;
const STEP_MS = 130;

const canvas = document.querySelector('#board');
const scoreOut = document.querySelector('#score');
const statusOut = document.querySelector('#status');
const startButton = document.querySelector('#start');
const pauseButton = document.querySelector('#pause');
const restartButton = document.querySelector('#restart');

const ctx = canvas.getContext('2d');
let state = createGame({ width: GRID_WIDTH, height: GRID_HEIGHT, seed: Date.now() });
let accumulator = 0;
let lastFrame = 0;

/**
 * Size the drawing buffer from the logical grid and the device pixel ratio so
 * the canvas stays crisp while CSS keeps it inside a narrow viewport.
 */
function resize() {
  const ratio = window.devicePixelRatio || 1;
  const css = canvas.clientWidth || state.width * CELL;
  const cell = Math.max(8, Math.floor(css / state.width));
  const cssWidth = cell * state.width;
  const cssHeight = cell * state.height;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  // Draw in grid units; the transform maps them onto the scaled buffer.
  ctx.setTransform(canvas.width / cssWidth, 0, 0, canvas.height / cssHeight, 0, 0);
  canvas.dataset.cell = cell;
}

function render() {
  const cell = Number(canvas.dataset.cell) || CELL;
  const { width, height } = state;
  ctx.clearRect(0, 0, cell * width, cell * height);
  ctx.fillStyle = '#10161f';
  ctx.fillRect(0, 0, cell * width, cell * height);

  const drawCell = (cellKey, colour, inset = 1) => {
    const [x, y] = cellKey.split(',').map(Number);
    ctx.fillStyle = colour;
    ctx.fillRect(x * cell + inset, y * cell + inset, cell - inset * 2, cell - inset * 2);
  };

  if (state.food) drawCell(state.food, '#e5a13c');
  state.snake.forEach((segment, index) => {
    drawCell(segment, index === 0 ? '#8ede8b' : index === state.snake.length - 1 ? '#2f7d3a' : '#46a254');
  });

  scoreOut.textContent = String(state.score);
  statusOut.textContent =
    state.status === 'over'
      ? state.outcome === 'win'
          ? 'You filled the board. Press restart.'
          : 'Game over. Press restart.'
      : { ready: 'Press start, then use arrow keys or WASD.', running: '', paused: 'Paused.' }[state.status];
  startButton.disabled = state.status === 'running';
  pauseButton.disabled = state.status !== 'running' && state.status !== 'paused';
  pauseButton.textContent = state.status === 'paused' ? 'Resume' : 'Pause';
  restartButton.disabled = state.status === 'ready';
}

function commit(next) {
  if (next !== state) {
    state = next;
    render();
  }
}

function pressDirection(direction) {
  // Starting on a ready board: the first arrow key also starts the game.
  if (state.status === 'ready') commit(start(state));
  else if (state.status === 'paused') commit(resume(state));
  commit(queueDirection(state, direction));
}

function onKey(event) {
  const keys = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    w: 'up',
    a: 'left',
    s: 'down',
    d: 'right',
  };
  const direction = keys[event.key] ?? keys[event.key.toLowerCase?.()];
  if (!direction) return false;
  const before = state.status;
  pressDirection(direction);
  // Arrows also scroll the page: only swallow them while actually playing, so
  // the first press on a ready board still starts the game without hijacking.
  if (state.status === 'running' && before === 'running') event.preventDefault();
  return true;
}

function bind() {
  startButton.addEventListener('click', () => commit(start(state)));
  pauseButton.addEventListener('click', () => {
    commit(state.status === 'paused' ? resume(state) : pause(state));
  });
  restartButton.addEventListener('click', () => {
    accumulator = 0;
    commit(restart(state));
  });

  document.addEventListener('keydown', onKey);
  canvas.addEventListener('pointerdown', () => {
    if (state.status === 'running') commit(pause(state));
    else if (state.status !== 'over') commit(start(state));
  });

  for (const button of document.querySelectorAll('[data-direction]')) {
    button.addEventListener('click', () => pressDirection(button.dataset.direction));
  }

  window.addEventListener('resize', () => {
    resize();
    render();
  });
}

/** One requestAnimationFrame per frame, one engine step per STEP_MS. */
function frame(now) {
  if (!lastFrame) lastFrame = now;
  accumulator += now - lastFrame;
  lastFrame = now;
  let advanced = false;
  while (accumulator >= STEP_MS && state.status === 'running') {
    accumulator -= STEP_MS;
    state = step(state);
    advanced = true;
  }
  // A paused or finished tab must not burst-fire steps on the next frame.
  if (accumulator > STEP_MS * 4) accumulator = 0;
  if (advanced) render();
  window.requestAnimationFrame(frame);
}

resize();
bind();
render();
window.requestAnimationFrame(frame);
