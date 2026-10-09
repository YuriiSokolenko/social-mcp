// Canvas shell for the Arkanoid smoke. Owns the DOM, the requestAnimationFrame
// loop and all drawing; every rule lives in engine.mjs.

import {
  STATUS,
  createGame,
  startGame,
  pauseGame,
  restartGame,
  movePaddle,
  setPaddleTarget,
  stepGame,
} from './engine.mjs';

const CONFIG = {
  width: 640,
  height: 480,
  brickColumns: 8,
  brickRows: 5,
};

const BRICK_COLORS = ['#e04f5f', '#f0883e', '#f5c542', '#58c26b', '#4aa3f0'];

export function boot(canvas, options = {}) {
  const context = canvas.getContext('2d');
  const state = createGame(CONFIG);
  const keys = new Set();
  let accumulator = 0;
  let lastFrame = 0;

  function worldFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    const clientX = event.clientX ?? (event.touches && event.touches[0] && event.touches[0].clientX);
    if (typeof clientX !== 'number' || rect.width === 0) {
      return null;
    }
    return ((clientX - rect.left) / rect.width) * state.width;
  }

  function resize() {
    const ratio = options.devicePixelRatio?.() ?? window.devicePixelRatio ?? 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    context.setTransform(canvas.width / state.width, 0, 0, canvas.height / state.height, 0, 0);
  }

  function onKeyDown(event) {
    const key = event.key;
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === ' ' || key === 'Spacebar') {
      event.preventDefault();
    }
    keys.add(key.length === 1 ? key.toLowerCase() : key);

    if (key === ' ' || key === 'Enter') {
      if (state.status === STATUS.READY || state.status === STATUS.PAUSED) {
        startGame(state);
      } else if (state.status === STATUS.RUNNING) {
        pauseGame(state);
      } else if (state.status === STATUS.WON || state.status === STATUS.LOST) {
        restartGame(state);
      }
    }
    if (key === 'p' || key === 'P' || key === 'Escape') {
      pauseGame(state);
    }
    if (key === 'r' || key === 'R') {
      restartGame(state);
    }
  }

  function onKeyUp(event) {
    const key = event.key;
    keys.delete(key.length === 1 ? key.toLowerCase() : key);
  }

  function onPointerMove(event) {
    const targetX = worldFromEvent(event);
    if (targetX !== null) {
      setPaddleTarget(state, targetX - state.paddle.width / 2);
    }
  }

  function onPointerDown(event) {
    onPointerMove(event);
    if (state.status === STATUS.READY) {
      startGame(state);
    } else if (state.status === STATUS.WON || state.status === STATUS.LOST) {
      restartGame(state);
    }
  }

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('touchmove', onPointerMove, { passive: true });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', resize);
  resize();

  function frame(now) {
    const dt = lastFrame === 0 ? 0 : Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;

    const velocity = (keys.has('ArrowLeft') || keys.has('a') ? -1 : 0) + (keys.has('ArrowRight') || keys.has('d') ? 1 : 0);
    if (velocity !== 0) {
      movePaddle(state, velocity * state.paddle.speed * dt);
    }

    if (state.status === STATUS.RUNNING) {
      accumulator += dt;
      // Fixed-step accumulator so display cadence never changes physics.
      const step = state.fixedStep;
      let guard = 20;
      while (accumulator >= step && guard > 0) {
        stepGame(state, step);
        accumulator -= step;
        guard -= 1;
      }
      if (guard === 0) {
        accumulator = 0;
      }
    }

    draw();
    window.requestAnimationFrame(frame);
  }

  function draw() {
    context.clearRect(0, 0, state.width, state.height);
    context.fillStyle = '#10131a';
    context.fillRect(0, 0, state.width, state.height);

    state.bricks.forEach((brick) => {
      if (!brick.alive) {
        return;
      }
      context.fillStyle = BRICK_COLORS[brick.row % BRICK_COLORS.length];
      context.fillRect(brick.x, brick.y, brick.width, brick.height);
    });

    context.fillStyle = '#f5f5f5';
    context.fillRect(state.paddle.x, state.paddle.y, state.paddle.width, state.paddle.height);

    context.beginPath();
    context.arc(state.ball.x, state.ball.y, state.ballRadius, 0, Math.PI * 2);
    context.fillStyle = '#f5c542';
    context.fill();
    context.closePath();

    context.fillStyle = '#f5f5f5';
    context.font = '16px monospace';
    context.fillText(`score ${state.score}`, 12, 22);
    context.fillText(`lives ${state.lives}`, state.width - 78, 22);

    if (state.status !== STATUS.RUNNING) {
      const labels = {
        [STATUS.READY]: 'Press Space or click to start',
        [STATUS.PAUSED]: 'Paused - press Space to resume',
        [STATUS.WON]: 'You won! Press R to restart',
        [STATUS.LOST]: 'Game over - press R to restart',
      };
      context.fillText(labels[state.status] ?? '', state.width / 2 - 120, state.height / 2);
    }
  }

  window.requestAnimationFrame(frame);

  function destroy() {
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('touchmove', onPointerMove);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('resize', resize);
  }

  return { state, destroy };
}

const canvas = document.getElementById('game');
if (canvas) {
  boot(canvas);
}
