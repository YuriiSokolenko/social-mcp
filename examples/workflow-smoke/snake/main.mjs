/**
 * Browser layer for the Snake smoke demo.
 *
 * All game rules live in `engine.mjs`; this module only schedules fixed
 * time-step ticks, paints the canvas, and turns input into engine calls.
 */
import { createGame, queueDirection, restart, start, step, stepMsFor, togglePause } from './engine.mjs';

const GRID = 21;
const MAX_DELTA_MS = 250; // A backgrounded tab must not burst-tick.

const KEY_DIRECTION = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
};

const readVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const COLORS = {
  board: readVar('--panel') || '#1b222c',
  grid: readVar('--grid') || '#232c38',
  snake: readVar('--snake') || '#6ee7a0',
  head: readVar('--snake-head') || '#d1fae5',
  food: readVar('--food') || '#fca5a5',
};

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const ui = {
  score: document.getElementById('score'),
  best: document.getElementById('best'),
  announce: document.getElementById('announce'),
  start: document.getElementById('start'),
  pause: document.getElementById('pause'),
};

const loadBest = () => {
  try {
    return Number(localStorage.getItem('workflow-smoke:snake:best')) || 0;
  } catch {
    return 0; // No storage (private mode): the in-memory best still works.
  }
};

let state = createGame({ width: GRID, height: GRID });
let best = loadBest();
let elapsed = 0;
let lastFrame = 0;

function saveBest(value) {
  try {
    localStorage.setItem('workflow-smoke:snake:best', String(value));
  } catch {
    /* storage unavailable is not fatal */
  }
}

function setState(next) {
  const wasFinished = state.status === 'over' || state.status === 'won';
  state = next; // eslint-rule-free: single writer for the mutable game handle.
  ui.score.textContent = String(next.score);
  if (next.score > best) {
    best = next.score;
    ui.best.textContent = String(best);
    saveBest(best);
  }
  if (next.status === 'over' && !wasFinished) {
    ui.announce.textContent = `Game over. Score ${next.score}. Press R for a new game.`;
  } else if (next.status === 'won') {
    ui.announce.textContent = `You filled the board. Score ${next.score}.`;
  } else if (next.status === 'paused') {
    ui.announce.textContent = 'Paused.';
  } else if (wasFinished && next.status === 'ready') {
    ui.announce.textContent = 'Ready. Press Start, or steer to begin.';
  }
}

const turn = (direction) => {
  if (state.status === 'ready') setState(start(state));
  setState(queueDirection(state, direction));
};

const newGame = () => setState(restart(state));

/** Match the bitmap to the CSS box so one cell is exactly one device pixel row. */
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const size = Math.max(1, Math.floor((canvas.clientWidth || 280) * dpr));
  if (canvas.width !== size) {
    canvas.width = size;
    canvas.height = size;
  }
}

function draw() {
  const cell = canvas.width / state.width;
  ctx.fillStyle = COLORS.board;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let i = 1; i < state.width; i += 1) {
    const at = Math.round(i * cell) + 0.5;
    ctx.beginPath();
    ctx.moveTo(at, 0);
    ctx.lineTo(at, canvas.height);
    ctx.moveTo(0, at);
    ctx.lineTo(canvas.width, at);
    ctx.stroke();
  }

  const paint = (point, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(point.x * cell + 1, point.y * cell + 1, cell - 2, cell - 2);
  };
  if (state.food) paint(state.food, COLORS.food);
  state.snake.forEach((point, i) => paint(point, i === 0 ? COLORS.head : COLORS.snake));
}

/** Fixed time step: advance the engine in whole `stepMsFor(score)` units only. */
function frame(now) {
  const delta = Math.min(MAX_DELTA_MS, now - (lastFrame || now));
  lastFrame = now;
  if (state.status === 'running') {
    elapsed += delta;
    const stepMs = stepMsFor(state.score);
    while (elapsed >= stepMs && state.status === 'running') {
      elapsed -= stepMs;
      setState(step(state));
    }
  } else {
    elapsed = 0;
  }
  draw();
  window.requestAnimationFrame(frame);
}

function steerKeys(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return; // leave browser chords alone
  const direction = KEY_DIRECTION[event.code];
  if (direction) {
    event.preventDefault();
    turn(direction);
    return;
  }
  if (event.code === 'Space' || event.code === 'Enter') {
    if (event.target === ui.pause || event.target === ui.start) return; // let the button activate
    event.preventDefault();
    if (state.status === 'over' || state.status === 'won') newGame();
    else setState(togglePause(state));
    return;
  }
  if (event.code === 'KeyR') {
    event.preventDefault();
    newGame();
  }
}

function bindUi() {
  ui.start.addEventListener('click', () => {
    if (state.status === 'over' || state.status === 'won') newGame();
    setState(start(state));
  });
  ui.pause.addEventListener('click', () => setState(togglePause(state)));
  document.getElementById('restart').addEventListener('click', () => newGame());
  for (const id of ['up', 'down', 'left', 'right']) {
    document.getElementById(id).addEventListener('click', () => turn(id));
  }
  window.addEventListener('keydown', steerKeys);

  // Swipe or tap the board for touch play.
  let touchFrom = null;
  canvas.addEventListener('touchstart', (event) => {
    touchFrom = event.touches[0];
  });
  canvas.addEventListener('touchend', (event) => {
    if (!touchFrom) return;
    const to = event.changedTouches[0];
    const dx = to.clientX - touchFrom.clientX;
    const dy = to.clientY - touchFrom.clientY;
    touchFrom = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
  });

  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  window.addEventListener('resize', resize);
  resize();
  ui.best.textContent = String(best);
}

bindUi();
window.requestAnimationFrame(frame);
