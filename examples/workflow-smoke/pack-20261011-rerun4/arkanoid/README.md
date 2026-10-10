# Arkanoid / Breakout — pack-20261011-rerun4 smoke example

Disposable workflow-smoke target for issue #773 (fresh fourth-pack E2E rerun,
independent baseline comparison against #763). This code is test output: it is
intended to be removed by a separate, explicitly scoped cleanup PR, not part of
this smoke run. No dependencies, no build step, no network access, no external
assets.

## Play

JavaScript modules need HTTP, so `file://` will not work. From the repository
root:

```sh
python -m http.server 8000
```

Then open:

```text
http://localhost:8000/examples/workflow-smoke/pack-20261011-rerun4/arkanoid/index.html
```

## Controls

| Input | Effect |
| --- | --- |
| Arrow Left / Arrow Right, `a` / `d` | Steer the paddle (keys can be held) |
| Pointer move / touch drag over the canvas | Steer the paddle to the pointer |
| Left / Right buttons | Steer the paddle (touch) |
| Start (becomes Resume when paused) | Launch the first ball, resume a paused game |
| Pause | Freeze the board |
| Restart | Rebuild the level and start a fresh run |
| Tap the canvas while playing | Pause |

## Rules

- Three lives. The playfield has left, right and top walls and **no floor**.
- A ball that passes the bottom costs one life and a new deterministic ball is
  served; losing the last life ends the game (`Game over`).
- Each brick is worth 10 points and is destroyed exactly once; clearing every
  brick wins (`You win!`).
- Paddle contact angle depends on where the ball lands: hit the left edge to
  send it left, the right edge to send it right.
- Ball speed is capped and the vertical component is floored, so the ball
  cannot tunnel through bricks/paddle or bounce horizontally forever.

## Layout

| File | Role |
| --- | --- |
| `engine.mjs` | Pure deterministic rules: state, fixed-step physics, collisions, score/lives, win/lose. No DOM, timers, randomness, or network. |
| `main.mjs` | Canvas rendering, DOM controls, keyboard/pointer/touch input, fixed-timestep frame loop |
| `index.html` | Page skeleton, canvas, score/lives, status region, buttons |
| `style.css` | Mobile-first responsive styling, dark palette |
| `engine.test.mjs` | `node:test` suite for the engine |

## Test

```sh
node --test examples/workflow-smoke/pack-20261011-rerun4/arkanoid/engine.test.mjs
```

The suite covers initial state, wall rebounds, paddle rebounds and steering,
a brick hit/score, no double scoring, life loss, game over, win,
start/pause/resume/restart, an edge (brick-corner) collision, speed cap and
in-bounds stability over a long run, paddle clamping, and rng determinism.

## Limitations

- The frame loop is tuned for ~60Hz displays; on very high refresh-rate or
  heavily throttled tabs the paddle advances in fixed per-frame increments.
- Pointer/touch steering is horizontal only, and tapping the canvas toggles
  pause, so a tap while playing does not steer.
- No audio, no extra levels, no multi-ball, no power-ups, no high-score
  persistence.
- The canvas is not screen-reader navigable; score, lives, and outcome are
  announced through the `role="status"` region instead.
