# Snake — pack-20261010 (issue #732)

Disposable E2E smoke target: a playable single-player Snake game built from
static HTML, CSS, Canvas and modern browser JS. No external assets, packages,
build step, secrets or network requests.

## Run it

JS modules require HTTP, so `file://` will not work. From the repository root:

```sh
python -m http.server 8000
```

Then open:

```
http://localhost:8000/examples/workflow-smoke/pack-20261010/snake/index.html
```

## Controls

- Arrow keys or WASD to steer (no immediate 180-degree reversal).
- Space starts, pauses and resumes.
- Start / Pause(Resume) / Restart buttons, plus on-screen direction buttons for
  touch. Tapping the board toggles pause.
- Score and a text game-over reason (`role="status"`, `aria-live`) are shown as
  text, not colour alone. The layout stays usable at mobile width.

## Files

| File | Role |
| --- | --- |
| `engine.mjs` | Pure, deterministic game engine: state creation, direction queue, tick, growth/scoring, wall/self collision, game over, restart. Food placement is injectable. No DOM, timers or network. |
| `main.mjs` | The only DOM module: canvas scaling, fixed-timestep `requestAnimationFrame` loop, keyboard/button/touch wiring, score and status rendering. |
| `index.html` | Accessible markup: canvas board, score, live status text, controls, on-screen d-pad. |
| `style.css` | Mobile-first layout, 44px touch targets, focus outlines, narrow-viewport stacking. |
| `engine.test.mjs` | `node --test` suite over the public engine API. No DOM, timers or network. |

## Tests

```sh
node --test examples/workflow-smoke/pack-20261010/snake/engine.test.mjs
```

Covers movement, growth/scoring, wall and self collision (including the
tail-vacated cell), direction-queue reversal refusal, start/pause/resume,
restart, bounded `run`, deterministic food spawn, near-full and full boards,
and board-completion win.
