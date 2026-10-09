# Snake - disposable workflow smoke demo

A single-player Snake game used to exercise the Planner -> Implementer ->
Reviewer -> CI -> Merge Gate pipeline end to end. It is **not** product code:
it adds no dependency, no build step, and no product route. Delete this whole
`examples/workflow-smoke/snake/` directory in a cleanup PR when the smoke run
is done.

## Run it

JS modules need an HTTP origin, so serve the repository root and open the page:

```sh
python -m http.server 8000
# then open http://localhost:8000/examples/workflow-smoke/snake/index.html
```

## Play it

- **Start** begins the game; **Pause** freezes it; **Restart** starts over.
- Steer with arrow keys or `W` / `A` / `S` / `D`; the on-screen pad works for
  touch, as does a swipe across the board. `Space` or `Enter` pauses, `R`
  starts a new game. Browser chords such as `Ctrl`/`Cmd` are never captured.
- Eating food grows the snake by one cell and adds one point. Hitting a wall or
  your own body ends the game; the score and a local best appear above the
  board and are announced to assistive technology through `aria-live`.

## Layout

| File                  | Responsibility                                              |
| --------------------- | ----------------------------------------------------------- |
| `engine.mjs`          | Pure rules: state, ticks, growth, collisions, win/lose      |
| `main.mjs`            | Canvas render loop, fixed time step, keyboard/touch, a11y    |
| `index.html`          | Markup, controls and live region                             |
| `style.css`           | Theme, canvas scaling, mobile-width layout                   |

The engine is deterministic by construction: no DOM, timer, network or
wall-clock access, and food placement draws from an injectable `rng`
(`mulberry32` is provided) so a seeded game replays identically.

## Test it

```sh
node --test examples/workflow-smoke/snake/engine.test.mjs
```

The suite covers movement, growth and scoring, wall and self collision, the
rejected 180-degree reversal, pause/resume, restart, and bounded food
placement including the full-grid win. It imports `engine.mjs` only, so it
runs headless with no browser and no network access.
