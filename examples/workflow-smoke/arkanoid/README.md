# Arkanoid / Breakout workflow smoke

Disposable, dependency-free Arkanoid / Breakout mini-game used to exercise the
Planner → Implementer → Reviewer → CI → Merge Gate pipeline.

## Run in the browser

The page uses ES modules, so it must be served over HTTP (`file://` will not
load `main.mjs`). From the repository root:

```sh
python -m http.server 8000
```

Then open <http://localhost:8000/examples/workflow-smoke/arkanoid/index.html>.

## Controls

| Input | Effect |
| --- | --- |
| Left / Right arrow, `A` / `D` | Move the paddle |
| Mouse move / touch drag | Move the paddle |
| Space / Enter | Start, or pause while running |
| `P` / `Esc` | Pause |
| `R` | Restart |

## Layout

- `engine.mjs` — deterministic rules: ball, paddle, brick grid, score, three
  lives, `ready`/`running`/`paused`/`won`/`lost` status, fixed-step physics.
  It imports nothing and touches no DOM, so the browser and Node share one
  source of truth.
- `main.mjs` — canvas, `requestAnimationFrame` loop with a fixed-step
  accumulator, input wiring and drawing only.
- `index.html` / `style.css` — responsive page shell.

## Run the tests

Offline and with no third-party packages:

```sh
node --test examples/workflow-smoke/arkanoid/engine.test.mjs
```

## Limitations

- Browser platform only; no audio, level editor or persistence.
- Fixed-step physics: the world advances in `FIXED_STEP` slices, so physics is
  independent of display cadence but not continuously differentiable.
- This directory is disposable smoke coverage; removal is expected in a separate
  cleanup pull request.
