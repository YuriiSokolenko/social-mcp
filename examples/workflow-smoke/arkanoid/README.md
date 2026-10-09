# Arkanoid / Breakout smoke game

Disposable end-to-end workflow smoke test (issue #662), **not** production code.
A playable Arkanoid / Breakout built from browser platform APIs and the Node
standard library only: no packages, no `package.json`, no CDN, no assets, no
network calls.

## Layout

| File | Role |
| --- | --- |
| `engine.mjs` | Pure rules and physics (state, collisions, scoring, lives, win/lose). No DOM, timer, or random API usage, so it is unit-testable. |
| `main.mjs` | Canvas rendering, DOM/HUD, keyboard / pointer / touch input, fixed-timestep `requestAnimationFrame` loop. |
| `index.html`, `style.css` | Page shell and responsive layout. |
| `engine.test.mjs` | `node --test` suite for the engine. |

## Run it in a browser

ES modules require a real HTTP origin, so serve the repository root:

```sh
python -m http.server 8000
```

Then open <http://localhost:8000/examples/workflow-smoke/arkanoid/index.html>
(opening `index.html` with `file://` fails with a module CORS error).

## Browser controls

- Move the paddle: `ArrowLeft` / `ArrowRight`, `A` / `D`, or pointer / touch drag over the canvas.
- Serve the ball: `Space` / `Enter` or the **Start** button.
- Pause / resume: `P` / `Esc` or the **Pause** button.
- Restart: `R` or the **Restart** button.

Rules: one brick is 100 points, 3 lives, a cleared grid wins, the third miss
ends the game. The canvas scales with its container via `aspect-ratio`.

## Run the tests

```sh
node --test examples/workflow-smoke/arkanoid/engine.test.mjs
```

Offline and deterministic: `engine.mjs` contains no timers, DOM APIs or
randomness, so the same input sequence always yields the same state sequence.

## Limitations

- Physics are verified only in Node; in-browser play is a manual check.
- Single level layout, no sound or extra brick types.
- Not wired into CI, which runs only the repository `tests/` suites.
