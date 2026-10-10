// Canvas + DOM shell for the Arkanoid smoke example. All rules live in
// ./engine.mjs; this file only adapts browser events to engine calls and
// draws the state. It owns no physics and no score/life bookkeeping.

import {
  createGame,
  step,
  start,
  serve,
  pause,
  resume,
  restart,
  isOver,
  movePaddleByDirections,
  setPaddleTarget,
} from "./engine.mjs";

// Tuned for ~60Hz displays: a fixed number of engine steps per animation
// frame keeps physics independent of frame-rate jitter.
const STEPS_PER_FRAME = 2;
const FRAME_MS = 1000 / 60;
const MAX_BURST_FRAMES = 4;

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const scoreLabel = document.getElementById("score");
const livesLabel = document.getElementById("lives");
const statusLabel = document.getElementById("status");
const startButton = document.getElementById("start");
const pauseButton = document.getElementById("pause");
const restartButton = document.getElementById("restart");

const VIEW = { width: 480, height: 360 };
const KEYS = {
  arrowleft: "left",
  a: "left",
  arrowright: "right",
  d: "right",
};

let state = createGame({ seed: 20261011 });
const held = new Set();
let pointerX = null;
let lastFrameAt = 0;
let frames = 0;
let accumulator = 0;

function cell() {
  return Number.parseFloat(canvas.dataset.cell ?? "1");
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = Math.max(1, Math.floor(canvas.clientWidth));
  const cssHeight = Math.round((cssWidth * VIEW.height) / VIEW.width);
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
  canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
  canvas.dataset.cell = String(cssWidth / VIEW.width);
  // Draw in playfield units; the transform maps them onto the DPR buffer.
  ctx.setTransform(canvas.width / VIEW.width, 0, 0, canvas.height / VIEW.height, 0, 0);
  render();
}

function text(content, size, color, align = "center") {
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(content, align === "center" ? VIEW.width / 2 : 12, VIEW.height / 2);
}

function render() {
  ctx.clearRect(0, 0, VIEW.width, VIEW.height);
  ctx.fillStyle = "#10161f";
  ctx.fillRect(0, 0, VIEW.width, VIEW.height);

  for (const brick of state.bricks) {
    if (!brick.alive) continue;
    ctx.fillStyle = "#3c5b7f";
    ctx.fillRect(brick.x, brick.y, brick.w, brick.h);
    ctx.strokeStyle = "#2b3a4d";
    ctx.lineWidth = 1;
    ctx.strokeRect(brick.x + 0.5, brick.y + 0.5, brick.w - 1, brick.h - 1);
  }

  ctx.fillStyle = "#8ec5ff";
  ctx.fillRect(state.paddle.x, state.paddle.y, state.paddle.width, state.paddle.height);

  ctx.beginPath();
  ctx.fillStyle = "#ffdf7e";
  ctx.arc(state.ball.x, state.ball.y, state.ballRadius, 0, Math.PI * 2);
  ctx.fill();

  text(`Score ${state.score}   Lives ${state.lives}`, 16, "#e7edf5");
  if (state.status === "ready") text("Press Start", 26, "#e7edf5");
  if (state.status === "paused") text("Paused", 26, "#ffdf7e");
  if (state.status === "over") {
    text(state.outcome === "win" ? "You win!" : "Game over", 28, "#ffdf7e");
  }

  scoreLabel.textContent = String(state.score);
  livesLabel.textContent = String(state.lives);
  statusLabel.textContent =
    state.status === "ready"
      ? "Ready — press Start."
      : state.status === "over"
        ? state.outcome === "win"
          ? "Win — all bricks cleared."
          : "Loss — out of lives."
        : `${state.status === "paused" ? "Paused" : "Playing"} — score ${state.score}, lives ${state.lives}.`;

  startButton.disabled = !(state.status === "ready" || state.status === "paused");
  startButton.textContent = state.status === "paused" ? "Resume" : "Start";
  pauseButton.disabled = state.status !== "running";
  restartButton.disabled = state.status === "ready";
}

function commit(next) {
  if (next !== state) {
    state = next;
    render();
  }
}

function frameAt(now) {
  const dtMs = lastFrameAt > 0 ? now - lastFrameAt : FRAME_MS;
  lastFrameAt = now;
  const clamped = Math.min(Math.max(dtMs, 0), FRAME_MS * MAX_BURST_FRAMES);

  if (state.status === "running") {
    accumulator = Math.min(accumulator + clamped, FRAME_MS * MAX_BURST_FRAMES);
    let advanced = 0;
    while (accumulator >= FRAME_MS && advanced < STEPS_PER_FRAME) {
      accumulator -= FRAME_MS;
      advanced += 1;
      if (isOver(state)) break;
      state = step(state);
    }
    if (advanced > 0) render();
  }
  window.requestAnimationFrame(frameAt);
}

function steer() {
  if (pointerX !== null) {
    commit(setPaddleTarget(state, pointerX));
    return;
  }
  commit(movePaddleByDirections(state, held, FRAME_MS));
}

function bind() {
  startButton.addEventListener("click", () => {
    pointerX = null;
    held.clear();
    accumulator = 0;
    lastFrameAt = 0;
    if (state.status === "paused") commit(resume(state));
    else if (state.status === "ready") {
      // Keep the served ball visible for a moment before physics starts.
      commit(start(serve(state)));
    }
  });

  pauseButton.addEventListener("click", () => {
    if (state.status === "running") commit(pause(state));
  });

  restartButton.addEventListener("click", () => {
    held.clear();
    pointerX = null;
    accumulator = 0;
    lastFrameAt = 0;
    commit(restart(state));
  });

  window.addEventListener("keydown", (event) => {
    const direction = KEYS[event.key.toLowerCase()];
    if (direction) {
      held.add(direction);
      pointerX = null;
      steer();
      if (state.status === "running") event.preventDefault();
    }
  });

  window.addEventListener("keyup", (event) => {
    const direction = KEYS[event.key.toLowerCase()];
    if (direction) held.delete(direction);
  });

  const toFieldX = (event) => {
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / VIEW.width;
    return (event.clientX - rect.left) / (scale || 1);
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (state.status === "running") {
      commit(pause(state));
      return;
    }
    if (state.status === "ready") {
      pointerX = toFieldX(event);
      commit(serve(setPaddleTarget(state, pointerX)));
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    pointerX = toFieldX(event);
    steer();
  });

  canvas.addEventListener("pointerleave", () => {
    pointerX = null;
  });

  for (const button of document.querySelectorAll("[data-direction]")) {
    const direction = button.dataset.direction;
    const press = (event) => {
      event.preventDefault();
      held.add(direction);
      pointerX = null;
      steer();
    };
    const release = () => held.delete(direction);
    button.addEventListener("pointerdown", press);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointerleave", release);
    button.addEventListener("pointercancel", release);
  }

  window.addEventListener("resize", resize);
}

bind();
resize();
frames = window.requestAnimationFrame(frameAt);
void frames;
