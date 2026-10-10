# Arkanoid / Breakout — workflow smoke (issue #755)

Disposable smoke-test output for the agent workflow, not product code. It is a
standalone, dependency-free Arkanoid / Breakout mini-game: a Canvas UI driven by
a pure, deterministic physics engine so the rules are unit-testable in Node.

## Play

ES modules do not load from `file://`, so serve the repository over HTTP:

```sh
# from the repository root
python -m http.server 8000
```

Then open <http://localhost:8000/examples/workflow-smoke/pack-20261010-rerun/arkanoid/index.html>.

### Controls

| Input | Effect |
| --- | --- |
| `←` / `→`, `A` / `D` | Slide the paddle (hold to keep moving) |
| Mouse move / touch drag on the board | Paddle follows the pointer |
| `Space` / `Enter`, **Start** button | Start the game and serve the ball |
| `P`, **Pause** button, tap the board | Pause / resume |
| `R`, **Restart** button | Rebuild the wall, score and lives |
| On-screen ◀ / ▶ buttons | Pointer/touch paddle steering |

Three lives. Clearing every brick wins; losing all lives ends the game. The
status line repeats the state in text, so it is not conveyed by colour alone.

## Layout

| File | Role |
| --- | --- |
| `index.html` | Canvas, score/lives/brick readouts, status live region, buttons |
| `style.css` | Mobile-first responsive layout, no external assets |
| `engine.mjs` | Pure deterministic rules: state, physics, collisions, scoring |
| `main.mjs` | Only DOM/Canvas file: rendering, input, fixed-timestep loop |
| `engine.test.mjs` | `node:test` suite for the engine |

## Test

```sh
node --test examples/workflow-smoke/pack-20261010-rerun/arkanoid/engine.test.mjs
```

## Limitations

- No third-party packages, no images, fonts, audio, or network requests.
- Single static wall: `level` exists in the state, but clearing the board wins
  instead of advancing to further levels; no power-ups, no multi-ball.
- Physics use a fixed `DT` with sub-stepping, so very large frame steps are
  clamped rather than simulated exactly; the suite asserts deterministic bounces
  at the standard step.
- Interactive Canvas and pointer behaviour is not machine-verified here; the
  Node suite covers the engine rules that `main.mjs` only renders.
