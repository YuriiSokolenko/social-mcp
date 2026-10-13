# Snake — `pack-20261011-rerun4`

A playable single-player Snake game built from static HTML, CSS and Canvas with
modern browser JavaScript. No external assets, no packages, no build step.

Fresh isolated smoke pack (issue #772). It is independent of the earlier
`examples/workflow-smoke/snake/` pack: nothing here imports or modifies it.

## Layout

| File | Role |
| --- | --- |
| `engine.mjs` | Pure, deterministic game rules (no DOM, timers, network or `Math.random`) |
| `main.mjs` | Only DOM file: canvas rendering, keyboard/touch input, fixed-timestep loop |
| `index.html` | Markup and accessible start/pause/restart controls |
| `style.css` | Layout, usable down to ~360 px width |
| `engine.test.mjs` | `node:test` suite for the engine |

## Play

JS modules need HTTP in browsers, so serve the repository root:

```sh
# from the repository root
python -m http.server 8000
```

Then open <http://localhost:8000/examples/workflow-smoke/pack-20261011-rerun4/snake/index.html>.

Controls:

- **Arrow keys** or **WASD** — steer (a 180° reversal into yourself is ignored)
- **Space** / **P** — start, pause, resume
- **R** — restart
- Buttons **Start**, **Pause**, **Restart** and the on-screen D-pad cover touch users.

Rules: 21×21 grid, snake starts at length 3, eating food grows the snake by one
segment and scores 1, hitting a wall or yourself ends the game, filling the
whole board ends the game as a win. The head may move into the cell the tail is
vacating on the same tick.

## Tests

```sh
node --test examples/workflow-smoke/pack-20261011-rerun4/snake/engine.test.mjs
```

24 deterministic tests: movement, growth/scoring, wall and self collision,
direction queueing and 180° rejection (including at start and while paused),
pause/resume/restart, tick counting, seeded food placement, bounded spawn on a
full grid, and grid-size validation. No DOM, timers, network or clock
dependencies; the same seed always produces the same game.
