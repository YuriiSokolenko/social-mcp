// Browser layer for the pack-20261010-rerun3 Snake pack.
//
// The only file that touches `document` / `window`: canvas painting, keyboard
// and touch input, and a fixed-timestep loop that drives `engine.step`.
// All rules live in `engine.mjs`, which keeps them testable in plain Node.

import {
  COLS,
  ROWS,
  createGame,
  isOver,
  pause,
  queueDirection,
  restart,
  resume,
  start,
  step,
} from './engine.mjs';

const CELL = 20;
const STEP_MS = 110;
const MAX_STEPS_PER_FRAME = 4;

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('start');
const pauseBtn = document.getElementById('pause');
const restartBtn = document.getElementById('restart');

const MESSAGE = {
  ready: 'Press Start, then use arrows or WASD.',
  running: 'Running. Space pauses.',
  paused: 'Paused. Press Resume to continue.',
  over: {
    wall: 'Game over: you hit the wall.',
    self: 'Game over: you bit yourself.',
    win: 'You filled the board. Well played!',
  },
};

let state = start(createGame({ width: COLS, height: ROWS, seed: 20261010 }));
let accumulator = 0;
let lastTime = 0;

/** Match the canvas buffer to the CSS size and devicePixelRatio. */
function resize() {
  const ratio = window.devicePixelRatio || 1;
  const size = Math.max(
    120,
    Math.min(canvas.clientWidth || COLS * CELL, window.innerWidth - 24),
  );
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.width = Math.round(size * ratio);
  canvas.height = Math.round(size * ratio);
  ctx.setTransform((canvas.width / COLS), 0, 0, (canvas.height / ROWS), 0, 0);
  render();
}

function paintCell(cell, style, inset = 0.08) {
  const [x, y] = cell.split(',').map(Number);
  ctx.fillStyle = style;
  ctx.fillRect(x + inset, y + inset, 1 - inset * 2, 1 - inset * 2);
}

function render() {
  ctx.fillStyle = '#101418';
  ctx.fillRect(0, 0, COLS, ROWS);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 0.03;
  for (let i = 1; i < COLS; i += 1) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, ROWS);
    ctx.stroke();
  }
  for (let j = 1; j < ROWS; j += 1) {
    ctx.beginPath();
    ctx.moveTo(0, j);
    ctx.lineTo(COLS, j);
    ctx.stroke();
  }
  if (state.food) paintCell(state.food, '#e5484d');
  state.snake.forEach((cell, index) => {
    paintCell(cell, index === 0 ? '#8ed34a' : '#4c9a2a');
  });
}

function describe(next) {
  if (next.status === 'over') return MESSAGE.over[next.outcome] ?? 'Game over.';
  return MESSAGE[next.status];
}

/** Commit a transition: repaint and sync the accessible UI only on change. */
function commit(next) {
  if (next === state) return;
  state = next;
  scoreEl.textContent = String(state.score);
  statusEl.textContent = describe(state);
  startBtn.disabled = state.status === 'running' || isOver(state);
  pauseBtn.disabled = state.status === 'ready' || isOver(state);
  pauseBtn.textContent = state.status === 'paused' ? 'Resume' : 'Pause';
  render();
}

function pressDirection(name) {
  if (state.status === 'ready') commit(start(state));
  commit(queueDirection(state, name));
}

function togglePause() {
  if (state.status === 'paused') commit(resume(state));
  else commit(pause(state));
}

const KEY_MAP = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
};

function onKey(event) {
  const name = KEY_MAP[event.key] ?? KEY_MAP[event.key?.toLowerCase?.()];
  if (name) {
    event.preventDefault();
    pressDirection(name);
    return;
  }
  if (event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault();
    if (isOver(state)) commit(restart(state));
    else if (state.status === 'ready') commit(start(state));
    else togglePause();
  }
}

function bind() {
  startBtn.addEventListener('click', () => commit(start(state)));
  pauseBtn.addEventListener('click', togglePause);
  restartBtn.addEventListener('click', () => {
    accumulator = 0;
    commit(restart(state));
  });
  for (const button of document.querySelectorAll('[data-direction]')) {
    button.addEventListener('click', () => pressDirection(button.dataset.direction));
  }
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', resize);
}

/** Consistent fixed timestep: real time feeds an accumulator, not the rules. */
function frame(now) {
  if (lastTime) accumulator += now - lastTime;
  lastTime = now;
  // A backgrounded tab can hand us a huge delta; drop it instead of running
  // hundreds of ticks into a wall.
  if (accumulator > STEP_MS * MAX_STEPS_PER_FRAME * 4) accumulator = 0;
  let steps = 0;
  while (accumulator >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
    accumulator -= STEP_MS;
    steps += 1;
    commit(step(state));
    if (state.status !== 'running') {
      accumulator = 0;
      break;
    }
  }
  window.requestAnimationFrame(frame);
}

bind();
resize();
commit({ ...state });
window.requestAnimationFrame(frame);
