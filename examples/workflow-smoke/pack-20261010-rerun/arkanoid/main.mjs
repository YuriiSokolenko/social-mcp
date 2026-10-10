// Browser layer for the Arkanoid smoke game (issue #755): Canvas rendering,
// input, and the fixed-timestep loop. All rules and physics live in
// engine.mjs, so they stay unit-testable in Node without a DOM.
import {
  DT,
  createGame,
  launch,
  movePaddle,
  pause,
  restart,
  resume,
  start,
  steerPaddle,
  step,
} from './engine.mjs';

/** Milliseconds per engine substep; the engine advances exactly DT seconds. */
const STEP_MS = DT * 1000;

const canvas = document.querySelector('#board');
const scoreOut = document.querySelector('#score');
const livesOut = document.querySelector('#lives');
const bricksOut = document.querySelector('#bricks');
const statusOut = document.querySelector('#status');
const startButton = document.querySelector('#start');
const pauseButton = document.querySelector('#pause');
const restartButton = document.querySelector('#restart');

const ctx = canvas.getContext('2d');
const KEY_TO_DIRECTION = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  a: 'left',
  d: 'right',
};

let state = createGame({ seed: Date.now() >>> 0 });
let accumulator = 0;
let lastFrame = 0;
/** Keys currently held down, so the paddle keeps gliding while pressed. */
const held = new Set();
let pointerX = null;

/**
 * Size the drawing buffer from the logical arena and the device pixel ratio so
 * the canvas stays crisp while CSS keeps it inside a narrow viewport.
 */
function resize() {
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || state.width;
  const cssHeight = cssWidth * (state.height / state.width);
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  // Draw in logical arena units; the transform maps them onto the buffer.
  ctx.setTransform(canvas.width / cssWidth, 0, 0, canvas.height / cssHeight, 0, 0);
  canvas.dataset.scale = String(cssWidth / state.width);
}

function brickColour(brick) {
  // Remaining hits are shown by hue, and the panel also lists bricks by text,
  // so state is never conveyed by colour alone.
  return brick.hits > 1 ? '#e5a13c' : '#7fd1b9';
}

function render() {
  const { width, height, paddle, ball } = state;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#10161f';
  ctx.fillRect(0, 0, width, height);

  ctx.lineWidth = 1;
  for (const brick of state.bricks) {
    if (brick.alive === false) continue;
    ctx.fillStyle = brickColour(brick);
    ctx.fillRect(brick.x, brick.y, brick.width, brick.height);
    ctx.strokeStyle = '#0b1018';
    ctx.strokeRect(brick.x + 0.5, brick.y + 0.5, brick.width - 1, brick.height - 1);
  }

  ctx.fillStyle = '#8ec5ff';
  ctx.fillRect(
    paddle.x - paddle.width / 2,
    paddle.y - paddle.height / 2,
    paddle.width,
    paddle.height,
  );

  ctx.fillStyle = '#ffdf7e';
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
  ctx.fill();

  scoreOut.textContent = String(state.score);
  livesOut.textContent = String(state.lives);
  bricksOut.textContent = String(state.bricksLeft);
  statusOut.textContent = statusText(state);

  startButton.disabled = state.status !== 'ready';
  startButton.textContent = state.ball.attached ? 'Start' : 'Launch';
  pauseButton.disabled = state.status !== 'running' && state.status !== 'paused';
  pauseButton.textContent = state.status === 'paused' ? 'Resume' : 'Pause';
  restartButton.disabled = state.status === 'ready' && state.steps === 0 && state.score === 0;
}

function statusText(current) {
  if (current.status === 'over') {
    return current.outcome === 'win'
      ? 'You cleared the board. Press restart.'
      : 'Game over. Press restart.';
  }
  if (current.status === 'paused') return 'Paused.';
  if (current.status === 'ready') {
    return 'Press start, then use arrow keys, A/D, mouse, or touch.';
  }
  return '';
}

function commit(next) {
  if (next !== state) {
    state = next;
    render();
  }
}

/** Start from `ready`, serve an attached ball, and resume from `paused`. */
function play() {
  if (state.status === 'paused') commit(resume(state));
  else if (state.status === 'ready') commit(start(state));
  else if (state.status === 'running' && state.ball.attached) commit(launch(state));
}

/** Apply held keys / last pointer position once per animation frame. */
function applyInput() {
  if (state.status === 'over') return;
  if (pointerX !== null) {
    commit(movePaddle(state, pointerX));
    return;
  }
  if (held.has('left') && !held.has('right')) commit(steerPaddle(state, 'left'));
  else if (held.has('right') && !held.has('left')) commit(steerPaddle(state, 'right'));
}

function keyName(event) {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

function onKey(event) {
  if (event.repeat) return false;
  const key = keyName(event);
  const direction = KEY_TO_DIRECTION[key];
  if (direction) {
    held.add(direction);
    pointerX = null;
    if (state.status === 'ready' || state.status === 'paused') play();
    // Arrows also scroll the page: swallow them only while actually playing.
    if (state.status === 'running') event.preventDefault();
    return true;
  }
  if (key === ' ' || key === 'Enter') {
    play();
    event.preventDefault();
    return true;
  }
  if (key === 'p') {
    commit(state.status === 'paused' ? resume(state) : pause(state));
    return true;
  }
  if (key === 'r') {
    reset();
    return true;
  }
  return false;
}

function onKeyUp(event) {
  const direction = KEY_TO_DIRECTION[keyName(event)];
  if (direction) held.delete(direction);
}

/** Map a pointer event to a logical arena x; the engine clamps it. */
function toArenaX(event) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return null;
  return ((event.clientX - rect.left) / rect.width) * state.width;
}

function reset() {
  accumulator = 0;
  held.clear();
  pointerX = null;
  commit(restart(state));
}

function steer(button) {
  const direction = button.dataset.move;
  const startSteering = () => {
    held.clear();
    pointerX = null;
    held.add(direction);
    if (state.status === 'ready' || state.status === 'paused') play();
  };
  const stopSteering = () => held.delete(direction);
  button.addEventListener('pointerdown', startSteering);
  button.addEventListener('pointerup', stopSteering);
  button.addEventListener('pointerleave', stopSteering);
  button.addEventListener('pointercancel', stopSteering);
}

function bind() {
  startButton.addEventListener('click', play);
  pauseButton.addEventListener('click', () => {
    commit(state.status === 'paused' ? resume(state) : pause(state));
  });
  restartButton.addEventListener('click', reset);

  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKeyUp);

  canvas.addEventListener('pointerdown', (event) => {
    const x = toArenaX(event);
    if (x !== null) {
      pointerX = x;
      commit(movePaddle(state, x));
    }
    // Tap the board to pause while a serve is in flight, otherwise to play.
    if (state.status === 'running' && !state.ball.attached) commit(pause(state));
    else play();
    event.preventDefault();
  });
  canvas.addEventListener('pointermove', (event) => {
    const x = toArenaX(event);
    if (x === null) return;
    pointerX = x;
    commit(movePaddle(state, x));
  });
  canvas.addEventListener('pointerleave', () => {
    pointerX = null;
  });

  for (const button of document.querySelectorAll('[data-move]')) steer(button);

  window.addEventListener('resize', () => {
    resize();
    render();
  });
}

/** One requestAnimationFrame per frame, one engine substep per STEP_MS. */
function frame(now) {
  if (!lastFrame) lastFrame = now;
  accumulator += now - lastFrame;
  lastFrame = now;
  applyInput();
  let advanced = false;
  while (accumulator >= STEP_MS && state.status === 'running') {
    accumulator -= STEP_MS;
    state = step(state);
    advanced = true;
  }
  // A paused or finished tab must not burst-fire steps on the next frame.
  if (accumulator > STEP_MS * 8) accumulator = 0;
  if (advanced) render();
  window.requestAnimationFrame(frame);
}

resize();
bind();
render();
window.requestAnimationFrame(frame);
