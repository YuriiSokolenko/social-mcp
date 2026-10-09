# Snake (workflow smoke)

Disposable end-to-end smoke target for the Pi Planner → Implementer → Reviewer →
CI → Merge Gate pipeline. Not product code; it is removed by a separate cleanup
PR once the run is accepted. No dependencies, no build step, no network access.

## Play

JavaScript modules need HTTP, so `file://` will not work. From the repository
root:

```sh
python -m http.server 8000
```

Then open <http://localhost:8000/examples/workflow-smoke/snake/index.html>.

Start, then steer with arrow keys or WASD, or the on-screen buttons. Eating food
grows the snake and adds a point; walls and your own tail end the game; filling
the board wins. Pause and restart are available from the buttons and tapping the
board pauses.

## Layout

| File                       | Role                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `engine.mjs`               | Pure game rules: state, direction queue, step, scoring, collisions. |
| `main.mjs`                 | The only DOM file: canvas drawing, input, fixed-timestep loop.     |
| `index.html`, `style.css`  | Accessible controls and a mobile-width layout.                     |
| `engine.test.mjs`          | Deterministic `node:test` suite — no DOM, no timers, no network.   |

Food placement is injected into the engine (a seedable generator by default), so
tests reproduce a board exactly and placement is bounded: when the snake owns
every cell there is no food to place and the game ends as a win.

## Test

```sh
node --test examples/workflow-smoke/snake/engine.test.mjs
```
