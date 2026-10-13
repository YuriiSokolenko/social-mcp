# Snake — pack-20261010-rerun

Disposable E2E smoke example for issue #754: a playable single-player Snake
game with no dependencies, no build step, no external assets, and no network
requests.

## Play it

JS modules need HTTP, so `file://` will not work. From the repository root:

```sh
python -m http.server 8000
```

Then open <http://localhost:8000/examples/workflow-smoke/pack-20261010-rerun/snake/index.html>.

- **Start / Pause / Restart** are real buttons; `Tab` reaches every control and
  the score/status region is an `aria-live` status.
- Steer with the arrow keys or `W`/`A`/`S`/`D`; the on-screen pad covers touch.
  A press that would reverse the snake into itself is ignored, including a
  second press inside the same tick.
- Tap the board to start or pause. Eating food grows the snake and adds a
  point; a wall, a self-collision, or a filled board ends the run and says why.

## Tests

```sh
node --test examples/workflow-smoke/pack-20261010-rerun/snake/engine.test.mjs
```

The suite covers movement, growth/scoring, wall and self collision, direction
queueing/reversal, pause/resume/restart, bounded food spawn, and the full-grid
win. It touches no DOM, timers, network, or filesystem.

## Files

| Path | Role |
| --- | --- |
| `engine.mjs` | Pure, deterministic rules: immutable state objects, injectable `rng`/food placement, `createGame`, `queueDirection`, `start`, `pause`, `resume`, `restart`, `step`, `run`. No DOM, timers, randomness globals, or network. |
| `main.mjs` | The only DOM file: canvas rendering, devicePixelRatio scaling, keyboard/touch/button input, fixed-timestep `requestAnimationFrame` loop. |
| `index.html` | Accessible markup, canvas, score, live status region, control buttons, on-screen direction pad. |
| `style.css` | Mobile-first layout, 44px tap targets, visible focus, system font stack. |
| `engine.test.mjs` | `node:test` suite for the rules. |
