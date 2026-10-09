// Canvas / DOM layer for the Arkanoid smoke game.
// All rules and physics live in engine.mjs; this file only draws and reads input.
import {
  DEFAULTS,
  STATUS,
  bricksRemaining,
  createGame,
  paddleTopY,
  pauseGame,
  restartGame,
  resumeGame,
  startGame,
  stepGame,
} from './engine.mjs';

const canvas = document.querySelector('#game');
const scoreOut = document.querySelector('#score');
const livesOut = document.querySelector('#lives');
const levelOut = document.querySelector('#level');
const statusOut = document.querySelector('#status');
const startBtn = document.querySelector('#start');
const pauseBtn = document.querySelector('#pause');
const restartBtn = document.querySelector('#restart');

const state = createGame();
const input = { paddleDir: 0, paddleTargetX: null };
const keys = new Set();

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(resizeCanvas).observe(canvas);
}

function setTarget(clientX) {
  const rect = canvas.getBoundingClientRect();
  const scale = state.width / rect.width;
  input.paddleTargetX = (clientX - rect.left) * scale;
}

canvas.addEventListener('pointerdown', (event) => {
  setTarget(event.clientX);
  canvas.setPointerCapture?.(event.pointerId);
});
canvas.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'mouse' || event.buttons > 0) {
    setTarget(event.clientX);
  }
});
canvas.addEventListener(
  'touchmove',
  (event) => {
    const touch = event.touches[0];
    if (touch) {
      setTarget(touch.clientX);
    }
  },
  { passive: true }
);

window.addEventListener('keydown', (event) => {
  const key = event.key;
  if (key === 'ArrowLeft' || key === 'a' || key === 'A') {
    keys.add('left');
  } else if (key === 'ArrowRight' || key === 'd' || key === 'D') {
    keys.add('right');
  } else if (key === ' ' || key === 'Enter') {
    startGame(state);
  } else if (key === 'p' || key === 'P' || key === 'Escape') {
    toggle();
  } else if (key === 'r' || key === 'R') {
    restart();
  }
});

window.addEventListener('keyup', (event) => {
  const key = event.key;
  if (key === 'ArrowLeft' || key === 'a' || key === 'A') {
    keys.delete('left');
  } else if (key === 'ArrowRight' || key === 'd' || key === 'D') {
    keys.delete('right');
  }
});

function toggle() {
  if (state.status === STATUS.RUNNING || state.status === STATUS.READY) {
    pauseGame(state);
  } else if (state.status === STATUS.PAUSED) {
    resumeGame(state);
  }
}

function restart() {
  restartGame(state);
  startGame(state);
}

startBtn.addEventListener('click', () => startGame(state));
pauseBtn.addEventListener('click', toggle);
restartBtn.addEventListener('click', restart);

function readInput() {
  const dir = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
  input.paddleDir = dir;
  const frame = { paddleDir: dir };
  if (input.paddleTargetX !== null && dir === 0) {
    frame.paddleTargetX = input.paddleTargetX;
  }
  return frame;
}

function draw(ctx) {
  const scale = canvas.width / state.width;
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  ctx.fillStyle = '#101826';
  ctx.fillRect(0, 0, state.width, state.height);

  // Bricks
  for (const brick of state.bricks) {
    if (!brick.alive) continue;
    ctx.fillStyle = '#7ac0ff';
    ctx.fillRect(brick.x, brick.y, brick.w, brick.h);
  }

  // Paddle
  ctx.fillStyle = '#f0f4f8';
  ctx.fillRect(
    state.paddle.x - state.paddle.width / 2,
    paddleTopY(state),
    state.paddle.width,
    state.paddle.height
  );

  // Ball
  ctx.fillStyle = '#ffd166';
  ctx.beginPath();
  ctx.arc(state.ball.x, state.ball.y, state.ball.r, 0, Math.PI * 2);
  ctx.fill();

  // Overlays
  if (state.status !== STATUS.RUNNING) {
    ctx.fillStyle = 'rgba(16, 24, 38, 0.72)';
    ctx.fillRect(0, 0, state.width, state.height);
    ctx.fillStyle = '#f0f4f8';
    ctx.textAlign = 'center';
    ctx.font = 'bold 30px system-ui, sans-serif';
    const message =
      state.status === STATUS.WON
        ? 'You cleared the level!'
        : state.status === STATUS.GAMEOVER
          ? 'Game over'
          : state.status === STATUS.PAUSED
            ? 'Paused'
            : `${bricksRemaining(state)} bricks left`;
    ctx.fillText(message, state.width / 2, state.height / 2);
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText(
      state.status === STATUS.READY
        ? 'Press Start or Space to serve'
        : 'Press R to restart',
      state.width / 2,
      state.height / 2 + 30
    );
  }

  ctx.restore();
}

function renderHud() {
  scoreOut.textContent = String(state.score);
  livesOut.textContent = String(state.lives);
  levelOut.textContent = String(state.level);
  statusOut.textContent = state.status;
}

// Fixed-timestep accumulator: the engine always advances by exactly one dt.
let accumulator = 0;
let last = 0;

function frame(now) {
  if (last === 0) last = now;
  accumulator += Math.min((now - last) / 1000, 0.25);
  last = now;

  let guard = 0;
  while (accumulator >= DEFAULTS.dt && guard < 1200) {
    stepGame(state, readInput());
    accumulator -= DEFAULTS.dt;
    guard += 1;
  }

  const ctx = canvas.getContext('2d');
  draw(ctx);
  renderHud();
  requestAnimationFrame(frame);
}

renderHud();
requestAnimationFrame(frame);
