// Browser layer for the Arkanoid smoke game: canvas rendering, input, and the
// fixed-timestep loop. Every rule (physics, collisions, scoring, lives) lives
// in engine.mjs, so this file only reads state and draws it. The engine owns
// the single fixed timestep (STEP_MS); real frame time is accumulated here and
// consumed in whole fixed steps, so the browser replays the same integration
// sequence the Node tests assert on.
import {
  LIVES,
  PLAYFIELD_HEIGHT,
  PLAYFIELD_WIDTH,
  STEP_MS,
  createGame,
  movePaddle,
  pause,
  resume,
  restart,
  setPaddleCenter,
  setPaddleVelocity,
  start,
  step,
} from './engine.mjs';

const canvas = document.querySelector('#board');
const scoreOut = document.querySelector('#score');
const livesOut = document.querySelector('#lives');
const bricksOut = document.querySelector('#bricks');
const statusOut = document.querySelector('#status');
const startButton = document.querySelector('#start');
const pauseButton = document.querySelector('#pause');
const restartButton = document.querySelector('#restart');

const ctx = canvas.getContext('2d');

// The engine has no clock, so seeding is a browser-side concern; tests inject
// their own seed and get an identical rally.
const options = { width: PLAYFIELD_WIDTH, height: PLAYFIELD_HEIGHT, seed: (Date.now() % 0xffffffff) || 1 };

let state = createGame(options);
let accumulator = 0;
let lastFrame = 0;
const pressed = new Set();

/**
 * Size the drawing buffer from the logical playfield and the device pixel
 * ratio, so the canvas stays crisp while CSS keeps it inside a narrow
 * viewport. All drawing then happens in logical playfield units.
 */
function resize() {
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || state.width;
  const cssHeight = (cssWidth * state.height) / state.width;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  ctx.setTransform(canvas.width / state.width, 0, 0, canvas.height / state.height, 0, 0);
}

function brickColour(brick) {
  // One hue per row keeps the wall readable without any external asset.
  const palette = ['#e56b6b', '#e5a13c', '#e5d76b', '#7fd184', '#7fb2e5'];
  return palette[Math.floor(brick.y / 24) % palette.length];
}

function overlay(lines) {
  ctx.font = '600 24px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffdf7e';
  lines.forEach((line, index) => {
    ctx.fillText(line, state.width / 2, state.height / 2 + index * 30 - (lines.length - 1) * 15);
  });
}

function render() {
  const { width, height, paddle, ball } = state;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#10161f';
  ctx.fillRect(0, 0, width, height);

  for (const brick of state.bricks) {
    if (!brick.alive) continue;
    ctx.fillStyle = brickColour(brick);
    ctx.fillRect(brick.x, brick.y, brick.width, brick.height);
  }

  ctx.fillStyle = '#8ec5ff';
  ctx.fillRect(paddle.x, paddle.y, paddle.width, paddle.height);

  ctx.beginPath();
  ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
  ctx.fillStyle = '#f2f6fb';
  ctx.fill();

  // The bottom band is the loss line, so make the drop edge visible.
  ctx.fillStyle = 'rgba(229, 107, 107, 0.4)';
  ctx.fillRect(0, height - 3, width, 3);

  if (state.status === 'ready') overlay(['Press Start', 'Arrows / A-D / drag to move']);
  else if (state.status === 'paused') overlay(['Paused']);
  else if (state.status === 'over') {
    overlay(state.outcome === 'win' ? ['You cleared the wall!', 'Press Restart'] : ['Game over', 'Press Restart']);
  }

  scoreOut.textContent = String(state.score);
  livesOut.textContent = String(state.lives);
  bricksOut.textContent = String(state.bricks.filter((brick) => brick.alive).length);
  statusOut.textContent =
    state.status === 'over'
      ? state.outcome === 'win'
        ? `Wall cleared with ${state.lives} of ${LIVES} balls left. Press restart.`
        : 'Out of balls. Press restart.'
      : {
          ready: 'Press start, then steer with arrow keys, A/D, mouse or touch.',
          running: '',
          paused: 'Paused.',
        }[state.status];

  startButton.disabled = state.status === 'running' || state.status === 'paused';
  pauseButton.disabled = state.status !== 'running' && state.status !== 'paused';
  pauseButton.textContent = state.status === 'paused' ? 'Resume' : 'Pause';
}

function commit(next) {
  if (next !== state) {
    state = next;
    render();
  }
}

/** Keyboard steering: the pressed-key set becomes one paddle velocity. */
function syncPaddleVelocity() {
  commit(setPaddleVelocity(state, (pressed.has('right') ? 1 : 0) - (pressed.has('left') ? 1 : 0)));
}

function onKey(event, down) {
  const keys = { ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right' };
  const key = keys[event.key] ?? keys[event.key.toLowerCase?.()];

  if (key) {
    if (down) pressed.add(key);
    else pressed.delete(key);
    syncPaddleVelocity();
    // Arrows also scroll the page: only swallow them while a rally is live.
    if (state.status === 'running') event.preventDefault();
    return true;
  }
  if (!down) return false;

  if (event.key === ' ' || event.key === 'Spacebar') {
    if (state.status === 'running') commit(pause(state));
    else if (state.status === 'paused') commit(resume(state));
    else commit(start(state));
    event.preventDefault();
    return true;
  }
  if (event.key === 'Escape' && state.status === 'running') {
    commit(pause(state));
    return true;
  }
  if (event.key === 'r' || event.key === 'R') {
    accumulator = 0;
    pressed.clear();
    commit(restart(state.options));
    event.preventDefault();
    return true;
  }
  return false;
}

/** Map a client X coordinate onto the logical playfield and steer there. */
function aimFromClientX(clientX) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  commit(setPaddleCenter(state, ((clientX - rect.left) / rect.width) * state.width));
}

function bind() {
  startButton.addEventListener('click', () => commit(start(state)));
  pauseButton.addEventListener('click', () => {
    commit(state.status === 'paused' ? resume(state) : pause(state));
  });
  restartButton.addEventListener('click', () => {
    accumulator = 0;
    pressed.clear();
    commit(restart(state.options));
  });

  document.addEventListener('keydown', (event) => onKey(event, true));
  document.addEventListener('keyup', (event) => onKey(event, false));

  // Pointer and touch drive the paddle directly; touch-action: none in CSS
  // keeps the drag from scrolling the page.
  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture?.(event.pointerId);
    aimFromClientX(event.clientX);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse' || event.buttons > 0) aimFromClientX(event.clientX);
  });

  window.addEventListener('resize', () => {
    resize();
    render();
  });
}

/**
 * One requestAnimationFrame per frame, one engine step per STEP_MS. Keyboard
 * velocity is applied as paddle displacement inside the same fixed step, so
 * paddle and ball always advance on the same clock.
 */
function frame(now) {
  if (!lastFrame) lastFrame = now;
  accumulator += now - lastFrame;
  lastFrame = now;

  let advanced = false;
  while (accumulator >= STEP_MS && state.status === 'running') {
    accumulator -= STEP_MS;
    const moved = state.paddle.velocity ? movePaddle(state, (state.paddle.velocity * STEP_MS) / 1000) : state;
    state = step(moved, { dtMs: STEP_MS });
    advanced = true;
  }
  // A paused tab, or a backgrounded one, must not burst-fire steps on resume.
  if (accumulator > STEP_MS * 4) accumulator = 0;
  if (advanced) render();
  window.requestAnimationFrame(frame);
}

resize();
bind();
render();
window.requestAnimationFrame(frame);
