# Arkanoid / Breakout (workflow smoke)

Disposable end-to-end smoke target for the Pi Planner → Implementer → Reviewer →
CI → Merge Gate pipeline. Not product code; it is removed by a separate cleanup
PR once the run is accepted. No dependencies, no build step, no network access,
no external assets.

## Play

JavaScript modules need HTTP, so `file://` will not work. From the repository
root:

```sh
python -m http.server 8000
```

Then open
<http://localhost:8000/examples/workflow-smoke/pack-20261010/arkanoid/index.html>.

Press **Start** (or Space). Steer the paddle with **arrow keys** or **A/D**, or
by moving the mouse / dragging a finger across the board. The ball bounces off
the left, right and top walls, the paddle and the bricks; each brick is credited
once and disappears. Clearing the whole wall wins. A ball that falls past the
paddle costs one of the three balls and a fresh one is served from the paddle;
losing the third ends the game. **Pause**/**Resume** (Space or Escape) freezes
the rally, **Restart** (or R) rebuilds the board.

## Layout

| File                      | Role                                                                          |
| ------------------------- | ----------------------------------------------------------------------------- |
| `engine.mjs`              | Pure rules: state, fixed-step integration, wall/paddle/brick collisions, scoring, lives, win/lose. |
| `main.mjs`                | The only DOM file: canvas drawing, keyboard/pointer input, fixed-timestep loop. |
| `index.html`, `style.css` | Accessible controls and a mobile-width layout.                                 |
| `engine.test.mjs`         | Deterministic `node:test` suite — no DOM, no timers, no network.               |

All randomness (the serve angle) comes from an injected seedable generator, and
the only time source is the fixed `STEP_MS` timestep exported by the engine, so
`createGame({ seed })` plus a step count reproduces a rally exactly and the
tests can assert physics in Node.

## Test

```sh
node --test examples/workflow-smoke/pack-20261010/arkanoid/engine.test.mjs
```

## Limitations

One fixed level (five brick rows) and no sound, power-ups, high scores, or
level editor — the issue asks for straightforward rules. The rally is single
player and pointer/keyboard only. The physics tests cover the engine; the
canvas layer is browser-only and has no automated test in this repository.
