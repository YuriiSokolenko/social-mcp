# Snake — pack-20261010-rerun3

Dependency-free single-player Snake for the `pack-20261010-rerun3` workflow
smoke pack: static HTML + CSS + Canvas, browser ES modules, and a pure game
engine that is unit-tested in plain Node. No packages, build step, external
assets, secrets, or network calls.

## Play

ES modules need HTTP (`file://` is blocked), so serve the repo root:

```sh
python -m http.server 8000
```

Open <http://localhost:8000/examples/workflow-smoke/pack-20261010-rerun3/snake/index.html>.

- **Arrows / WASD** steer, **Space** starts and pauses.
- **Start / Pause / Resume / Restart** are keyboard reachable and announce
  state through the `role="status"` region.
- **On-screen arrows** cover touch; the canvas scales with the viewport and
  stays usable at ~320px width.
- Eating grows the snake by one and scores one point. A wall or a bite ends
  the run; filling the grid wins.

## Files

| Path | Role |
| --- | --- |
| `engine.mjs` | All rules: state creation, direction queue, tick, growth/score, collisions, pause/restart. No DOM, timers, or network. |
| `main.mjs` | The only browser-facing file: canvas painting, input, fixed-timestep loop. |
| `index.html`, `style.css` | Accessible shell, mobile-first layout. |
| `engine.test.mjs` | `node:test` suite for the engine. |

## Tests

```sh
node --test examples/workflow-smoke/pack-20261010-rerun3/snake/engine.test.mjs
```

Food placement is injectable (`createGame({ placeFood })`) and the default
`placeFood` picks from a materialised list of free cells using a seedable
generator (`createRng(seed)`), so spawning is bounded, deterministic, never
lands on the snake, and returns `null` on a full grid. The suite covers
movement, growth/scoring, wall and self collision, tail-following, reversal
refusal (immediate and queued within one tick), pause/resume/restart, bounded
spawn, and the full-grid win — with no DOM, timers, randomness, or network.
