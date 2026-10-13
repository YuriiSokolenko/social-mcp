// Browser UI for the Snake game: the only DOM-touching file.
// All rules live in ./engine.mjs; this module owns input, the fixed-timestep
// loop and canvas rendering.

import {
  DIRECTIONS,
  GRID_HEIGHT,
  GRID_WIDTH,
  KEY_DIRECTIONS,
  STATUS_OVER,
  STATUS_PAUSED,
  STATUS_READY,
  createGame,
  parseKey,
  pause,
  queueDirection,
  restart,
  resume,
  start,
  step,
} from './engine.mjs';

const CELL = 20;
const STEP_MS = 110;

const OUTCOME_TEXT = {
  wall: 'You hit the wall!',
  self: 'You bit yourself!',
  win: 'Board full — you win!',
};

const STATUS_TEXT = {
  ready: 'Ready',
  running: 'Running',
  paused: 'Paused',
  over: 'Game over',
};

const els = {};
let state = createGame();
let accumulator = 0;
let lastFrame = 0;
let running = false;

function cacheElements() {
  const ids = ['board', 'score', 'status', 'message', 'start', 'pause', 'restart'];
  for (const id of ids) els[id] = document.getElementById(id);
  els.ctx = els.board.getContext('2d');
}

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = GRID_WIDTH * CELL;
  const h = GRID_HEIGHT * CELL;
  els.board.width = Math.round(w * dpr);
  els.board.height = Math.round(h * dpr);
  els.board.style.aspectRatio = `${GRID_WIDTH} / ${GRID_HEIGHT}`;
  els.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

function drawCell(x, y, style, inset = 1) {
  els.ctx.fillStyle = style;
  els.ctx.fillRect(x * CELL + inset, y * CELL + inset, CELL - inset * 2, CELL - inset * 2);
}

function render() {
  const w = GRID_WIDTH * CELL;
  const h = GRID_HEIGHT * CELL;

  els.ctx.fillStyle = '#0d1424';
  els.ctx.fillRect(0, 0, w, h);

  els.ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  els.ctx.lineWidth = 1;
  for (let x = 1; x < GRID_WIDTH; x += 1) {
    els.ctx.beginPath();
    els.ctx.moveTo(x * CELL + 0.5, 0);
    els.ctx.lineTo(x * CELL + 0.5, h);
    els.ctx.stroke();
  }
  for (let y = 1; y < GRID_HEIGHT; y += 1) {
    els.ctx.beginPath();
    els.ctx.moveTo(0, y * CELL + 0.5);
    els.ctx.lineTo(w, y * CELL + 0.5);
    els.ctx.stroke();
  }

  if (state.food) {
    const f = parseKey(state.food);
    drawCell(f.x, f.y, '#ff6b6b', 3);
  }

  state.snake.forEach((cell, index) => {
    const p = parseKey(cell);
    drawCell(p.x, p.y, index === 0 ? '#8ef2a8' : '#37b96b');
  });

  if (state.status === STATUS_OVER) {
    els.ctx.fillStyle = 'rgba(6, 10, 20, 0.72)';
    els.ctx.fillRect(0, 0, w, h);
    els.ctx.fillStyle = '#ffffff';
    els.ctx.textAlign = 'center';
    els.ctx.font = `bold ${Math.round(CELL * 1.2)}px system-ui, sans-serif`;
    els.ctx.fillText(OUTCOME_TEXT[state.outcome] ?? 'Game over', w / 2, h / 2);
    els.ctx.font = `${Math.round(CELL * 0.8)}px system-ui, sans-serif`;
    els.ctx.fillText('Press Restart to play again', w / 2, h / 2 + CELL * 1.6);
    els.ctx.textAlign = 'start';
  }
}

function renderHud() {
  els.score.textContent = String(state.score);
  els.status.textContent = STATUS_TEXT[state.status] ?? state.status;
  els.message.textContent = state.status === STATUS_OVER
    ? (OUTCOME_TEXT[state.outcome] ?? 'Game over')
    : state.status === STATUS_PAUSED
      ? 'Game paused.'
      : state.status === STATUS_READY
        ? 'Press Start, or an arrow key / WASD, to begin.'
        : `Length ${state.snake.length}.`;
  els.pause.disabled = state.status !== STATUS_RUNNING;
  els.start.disabled = state.status === STATUS_RUNNING || state.status === STATUS_OVER;
}

function frame(timestamp) {
  if (!running) return;
  if (!lastFrame) lastFrame = timestamp;
  accumulator += Math.min(timestamp - lastFrame, STEP_MS * 4);
  lastFrame = timestamp;

  while (accumulator >= STEP_MS) {
    const next = step(state);
    state = next;
    accumulator -= STEP_MS;
    if (next.status === STATUS_OVER) {
      accumulator = 0;
      break;
    }
  }

  render();
  renderHud();
  window.requestAnimationFrame(frame);
}

function loop() {
  running = true;
  lastFrame = 0;
  accumulator = 0;
  window.requestAnimationFrame(frame);
}

function stopLoop() {
  running = false;
}

function commit(next) {
  state = next;
  render();
  renderHud();
}

function onStart() {
  commit(start(state));
  loop();
}

function onPause() {
  stopLoop();
  commit(pause(state));
}

function onResume() {
  commit(resume(state));
  loop();
}

function onRestart() {
  stopLoop();
  commit(restart(state));
}

function onTogglePause() {
  if (state.status === STATUS_PAUSED) onResume();
  else if (state.status === STATUS_READY) onStart();
  else onPause();
}

function handleDirection(name) {
  if (!Object.hasOwn(DIRECTIONS, name)) return false;
  if (state.status === STATUS_OVER) return false;
  if (state.status === STATUS_READY) onStart();
  commit(queueDirection(state, name));
  return true;
}

function bindKeyboard() {
  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    if (key === ' ' || key === 'p') {
      event.preventDefault();
      onTogglePause();
      return;
    }
    if (key === 'r') {
      event.preventDefault();
      onRestart();
      return;
    }
    const name = KEY_DIRECTIONS[key];
    if (!name) return;
    event.preventDefault();
    handleDirection(name);
  });
}

function bindButtons() {
  els.start.addEventListener('click', onStart);
  els.pause.addEventListener('click', onTogglePause);
  els.restart.addEventListener('click', onRestart);

  document.querySelectorAll('[data-direction]').forEach((button) => {
    button.addEventListener('click', () => {
      handleDirection(button.dataset.direction);
      button.blur();
    });
  });
}

function boot() {
  cacheElements();
  sizeCanvas();
  window.addEventListener('resize', sizeCanvas);
  bindKeyboard();
  bindButtons();
  renderHud();
  if (state.status === STATUS_READY) render();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}

export {
  STATUS_PAUSED,
  bindButtons,
  bindKeyboard,
  boot,
  handleDirection,
  onRestart,
  onResume,
  onStart,
  sizeCanvas,
  stopLoop,
};
