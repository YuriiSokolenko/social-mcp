// Canvas client: rendering and input only. All gameplay rules live in engine.mjs.
import {
  bricksRemaining,
  createGame,
  movePaddleTo,
  paddleInput,
  resetGame,
  setPaused,
  startGame,
  step,
} from './engine.mjs';

const STEP_DT = 1 / 60;
const KEYS = { ArrowLeft: -1, ArrowRight: 1, a: -1, d: 1 };
const PALETTE = ['#ff8fa3', '#ffb86b', '#ffe08a', '#a6e1a1', '#a9c7ff'];

const canvas = document.getElementById('game');
const statusEl = document.getElementById('status');
const ctx = canvas.getContext('2d');
const game = createGame();
const pressed = new Set();
let accumulator = 0;
let last = 0;

function resize() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = game.width * ratio;
  canvas.height = game.height * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function pointerX(clientX) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return game.paddle.x;
  return ((clientX - rect.left) / rect.width) * game.width;
}

function togglePlay() {
  if (game.status === 'paused') setPaused(game, false);
  else if (game.status === 'running') setPaused(game, true);
  else startGame(game);
}
window.addEventListener('keydown', (event) => {
  if (event.key in KEYS) {
    pressed.add(KEYS[event.key]);
    event.preventDefault();
    return;
  }
  if (event.key === ' ' || event.key === 'Enter' || event.key === 'p') togglePlay();
  else if (event.key === 'r') resetGame(game);
});

window.addEventListener('keyup', (event) => {
  if (event.key in KEYS) pressed.delete(KEYS[event.key]);
});

canvas.addEventListener('pointermove', (event) => {
  movePaddleTo(game, pointerX(event.clientX));
});

canvas.addEventListener('touchmove', (event) => {
  const touch = event.touches[0];
  if (touch) movePaddleTo(game, pointerX(touch.clientX));
  event.preventDefault();
}, { passive: false });

for (const [id, action] of [['start', () => startGame(game)], ['pause', togglePlay], ['restart', () => resetGame(game)]]) {
  const button = document.getElementById(id);
  if (button) button.addEventListener('click', action);
}

function direction() {
  let sum = 0;
  for (const value of pressed) sum += value;
  return sum;
}

function overlayText() {
  if (game.status === 'ready') return 'Press Space to launch';
  if (game.status === 'paused') return 'Paused';
  if (game.status === 'won') return 'You won! Press R to restart';
  if (game.status === 'lost') return 'Game over - press R to restart';
  return '';
}

function render() {
  const { paddle, ball } = game;

  ctx.clearRect(0, 0, game.width, game.height);
  ctx.fillStyle = '#101426';
  ctx.fillRect(0, 0, game.width, game.height);

  for (const brick of game.bricks) {
    if (!brick.alive) continue;
    ctx.fillStyle = PALETTE[brick.row % PALETTE.length];
    ctx.fillRect(brick.x, brick.y, brick.width, brick.height);
  }

  ctx.fillStyle = '#8fd3ff';
  ctx.fillRect(paddle.x - paddle.width / 2, paddle.y, paddle.width, paddle.height);

  ctx.beginPath();
  ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
  ctx.fillStyle = '#ffe08a';
  ctx.fill();

  ctx.fillStyle = '#e8ecff';
  ctx.font = '16px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`Score ${game.score}`, 16, 24);
  ctx.textAlign = 'right';
  ctx.fillText(`Lives ${'\u2022 '.repeat(game.lives)}`, game.width - 16, 24);

  const line = overlayText();
  if (line) {
    ctx.fillStyle = 'rgba(8, 10, 20, 0.62)';
    ctx.fillRect(0, game.height / 2 - 36, game.width, 72);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(line, game.width / 2, game.height / 2 + 9);
  }

  if (statusEl) {
    statusEl.textContent = `${game.status} / score ${game.score} / lives ${game.lives}` +
      ` / bricks ${bricksRemaining(game)}`;
  }
}

function frame(time) {
  const elapsed = last === 0 ? 0 : Math.min((time - last) / 1000, 0.25);
  last = time;
  accumulator += elapsed;
  while (accumulator >= STEP_DT) {
    paddleInput(game, direction(), STEP_DT);
    step(game, STEP_DT);
    accumulator -= STEP_DT;
  }
  render();
  window.requestAnimationFrame(frame);
}

window.addEventListener('resize', resize);
resize();
render();
window.requestAnimationFrame(frame);
