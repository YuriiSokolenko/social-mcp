/**
 * Browser layer: the only DOM-touching module.
 * Renders engine state to a canvas and drives fixed-timestep updates.
 */
import {
  GRID_WIDTH,
  GRID_HEIGHT,
  DIRECTIONS,
  createGame,
  start,
  pause,
  resume,
  restart,
  queueDirection,
  step,
  parseKey,
} from './engine.mjs';

const CELL = 20;
const STEP_MS = 110;

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('start');
const pauseBtn = document.getElementById('pause');
const restartBtn = document.getElementById('restart');

let state = createGame({ width: GRID_WIDTH, height: GRID_HEIGHT, seed: 20261010 });

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || canvas.width || CELL * GRID_WIDTH;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssWidth * dpr);
  // Draw in grid units so layout stays simple and the canvas stays crisp.
  ctx.setTransform(canvas.width / GRID_WIDTH, 0, 0, canvas.height / GRID_HEIGHT, 0, 0);
  render();
}

function statusText(s) {
  switch (s.status) {
    case 'ready':
      return 'Ready — press an arrow key, WASD, or Start.';
    case 'running':
      return 'Running — Space pauses.';
    case 'paused':
      return 'Paused — press Space or Resume.';
    default:
      if (s.outcome === 'win') return 'Game over: you filled the board!';
      if (s.outcome === 'wall') return 'Game over: you hit the wall.';
      if (s.outcome === 'self') return 'Game over: you bit yourself.';
      return 'Game over.';
  }
}

function drawCell(x, y, fill) {
  ctx.fillStyle = fill;
  ctx.fillRect(x + 0.5, y + 0.5, 0.9, 0.9);
}

function render() {
  ctx.clearRect(0, 0, GRID_WIDTH, GRID_HEIGHT);
  ctx.fillStyle = '#101418';
  ctx.fillRect(0, 0, GRID_WIDTH, GRID_HEIGHT);

  if (state.food) {
    const { x, y } = parseKey(state.food);
    drawCell(x, y, '#e8564f');
  }

  state.snake.forEach((cell, index) => {
    const { x, y } = parseKey(cell);
    const fill = index === 0 ? '#a6f14c' : index === state.snake.length - 1 ? '#4d7a25' : '#79c93a';
    drawCell(x, y, fill);
  });

  if (scoreEl) scoreEl.textContent = String(state.score);
  if (statusEl) statusEl.textContent = statusText(state);
  if (startBtn) startBtn.disabled = state.status === 'running' || state.status === 'over';
  if (pauseBtn) {
    const toggleable = state.status === 'running' || state.status === 'paused';
    pauseBtn.disabled = !toggleable;
    pauseBtn.textContent = state.status === 'paused' ? 'Resume' : 'Pause';
  }
}

function commit(next) {
  if (next !== state) {
    state = next;
    render();
  }
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
  const name = KEY_MAP[event.key] || KEY_MAP[String(event.key).toLowerCase()];
  if (name) {
    if (state.status === 'running') event.preventDefault();
    if (state.status === 'ready') commit(start(state));
    else if (state.status === 'paused') commit(resume(state));
    commit(queueDirection(state, name));
    return;
  }
  if (event.key === ' ' || event.code === 'Space') {
    if (state.status === 'running') {
      event.preventDefault();
      commit(pause(state));
    } else if (state.status === 'paused') {
      event.preventDefault();
      commit(resume(state));
    } else if (state.status === 'ready') {
      event.preventDefault();
      commit(start(state));
    }
  }
}

function bind() {
  if (startBtn) startBtn.addEventListener('click', () => commit(start(state)));
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      if (state.status === 'running') commit(pause(state));
      else if (state.status === 'paused') commit(resume(state));
    });
  }
  if (restartBtn) restartBtn.addEventListener('click', () => commit(restart(state)));

  canvas.addEventListener('pointerdown', () => {
    if (state.status === 'running') commit(pause(state));
    else if (state.status === 'paused') commit(resume(state));
    else if (state.status === 'ready') commit(start(state));
  });

  document.querySelectorAll('[data-direction]').forEach((button) => {
    const direction = button.getAttribute('data-direction');
    if (!Object.prototype.hasOwnProperty.call(DIRECTIONS, direction)) return;
    button.addEventListener('click', () => {
      if (state.status === 'ready') commit(start(state));
      else if (state.status === 'paused') commit(resume(state));
      commit(queueDirection(state, direction));
    });
  });

  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', resize);
}

let last = 0;
let accumulator = 0;

function frame(now) {
  if (!last) last = now;
  let delta = now - last;
  last = now;
  // Clamp so a backgrounded/paused tab cannot burst-fire catch-up steps.
  if (delta > STEP_MS * 4) delta = STEP_MS * 4;
  accumulator += delta;

  while (accumulator >= STEP_MS) {
    accumulator -= STEP_MS;
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
window.requestAnimationFrame(frame);
