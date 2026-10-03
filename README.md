# Lode Runner-Style Terminal Game

A playable, ten-level Lode Runner-style arcade game for a normal Linux/macOS
terminal, implemented with the Python standard library only.

## Running

From the repository root:

```bash
python -m lode_runner
```

Other invocations:

```bash
python -m lode_runner --check    # validate all ten level maps and print a summary
python -m lode_runner --legend   # print the symbol legend
```

The game needs an interactive terminal of at least **60 columns by 22 rows**.
If the window is smaller, the game exits with a message instead of drawing a
scrambled screen. The terminal is always restored to its original mode on
normal exit, on Ctrl-C, and on unhandled errors.

## Controls

| Key                | Action                          |
| ------------------ | ------------------------------- |
| Arrow keys / `WASD` | Move, climb ladders, hang on ropes |
| `Z`                | Dig the brick diagonally down-left |
| `X`                | Dig the brick diagonally down-right |
| `R`                | Restart the current level      |
| `P`                | Pause / resume                 |
| `H`                | Toggle the help overlay        |
| `C`                | Toggle the ASCII/Unicode glyph set |
| `Q`                | Quit                           |

Input is read one byte at a time in raw mode, so holding or rapidly pressing a
movement key just queues more actions; it never leaves the terminal in an
unexpected state.

## Symbol legend

| Symbol | Meaning       | Notes                                                   |
| ------ ------------- | ---------------- | --------------------------------------------------------- |
| ` `     | empty            | entities fall through                                   |
| `#`     | solid block      | indestructible, supports entities, never diggable       |
| `B`      | brick              | diggable; a dug hole regenerates after 60 ticks          |
| `L`      | ladder             | climb up/down; a ladder cell holds an entity up           |
| `=`      | rope               | hang from it and walk along it; dropping off the end falls |
| `o`      | gold               | collect it; all gold must be resolved to open the exit  |
| `X`      | exit               | completing the level once the exit is open                |
| `@`      | player start       | exactly one per level                                   |
| `G`      | guard              | chases the player                                        |

The renderer's default `ascii` glyph set uses the symbols above. The `unicode`
set (`C` key) draws nicer block glyphs; `.` marks an open dug hole.

## Rules

* Walk left/right, climb ladders, and hang from ropes. Anything not standing on
  brick/rock, not on a ladder and not hanging from a rope falls one cell per
  tick.
* Gold chests sit on the floor; walking onto one collects it.
* The exit stays sealed until **every** gold piece is resolved, i.e. either
  collected by the player or resting back on the board. Guards may pick gold up
  and carry it for 30 ticks, then always return it to its original cell, so a
  guard can never permanently hide required gold. If a guard holding gold dies,
  the gold returns immediately.
* While standing, dig diagonally down-left (`Z`) or down-right (`X`) into brick.
  You cannot dig rock, ladders, ropes, empty space, dug holes, or a cell that an
  entity occupies.
* A dug hole stays open for `HOLE_LIFETIME` (60) ticks and then regenerates. An
  entity inside the regenerating brick is killed: a guard respawns at its start
  after 20 ticks and scores 50 points; the player only survives if they can
  climb out, otherwise the level restarts.
* Guards fall into holes, are trapped for `TRAP_DURATION` (20) ticks, then climb
  out and resume the chase.
* Any contact with an active guard costs a life and restores the level to its
  initial deterministic state.

## Scoring and lives

* Gold: **+25**. A trapped/entombed guard: **+50**. Completing a level: **+500**.
* New games start with **3 lives** (`Engine(lives=...)`).
* Dying restarts the current level and restores the score the player had when
  the level started, so a restart can never be used to farm points. Losing the
  last life ends the game; clearing level 10 shows the victory screen and allows
  a clean exit or a new game.

## Terminal assumptions and rendering

* Plain ANSI terminal (no GUI, no curses dependency).
* Frames are painted in place: the loop moves the cursor home and repaints the
  whole screen each tick instead of scrolling, so nothing flickers or scrolls
  away.
* The cursor is hidden during play and shown again afterwards; the alternate
  screen buffer is used and released.
* Simulation ticks are driven by a fixed 1/15 s cadence but the game logic never
  reads the clock, so it is fully deterministic and testable headlessly.

## Architecture

```
lode_runner/
  levels.py          symbol legend, level parsing, validation, reachability proofs
  builtin_levels.py  the ten handcrafted level maps and their constraints
  game.py            one level: entities, gravity, digging, guard AI, events
  engine.py          progression, lives, score, pause, restart
  render.py          game state -> text lines (charset glyphs, status, help)
  terminal.py        raw mode, key decoding, size check, ANSI painters
  std_interface.py   the stdin/stdout terminal session object
  app.py             the interactive game loop
  cli.py             argument parsing and the --check/--legend validation hooks
```

Game logic is completely decoupled from the terminal: `Game.step(action)` takes
an explicit action and advances exactly one tick, and `Renderer` turns that state
into plain strings, so the whole game runs headlessly in tests.

## Level authoring

Levels are rectangular text maps (see the legend above). `builtin_levels.py`
renders them from declarative descriptions (ground row, floors, ladders, ropes,
gold chests one row above the floor they rest on, guards, player, exit).

Every map must be rectangular, contain exactly one `@`, one `X`, at least one
`G`, the declared minimum of gold, and fit the 60x22 minimum terminal. The
loader also proves a completion route exists: either walking (including falling
and ladders) or, for the levels designed around digging, by opening at most two
brick holes. Run `python -m lode_runner --check` to validate all ten.

The ten levels are: First Run, First Dig, Rope Walk, Trap Lesson, Split Tower,
False Floors, Guard Traffic, The Vault, Vertical Maze, Final Gauntlet.

## Running the tests

```bash
pytest tests/test_lode_runner.py
```

No test needs a TTY. The suite covers level parsing and validation, the ten
bundled maps, movement (walk, ladder, rope, gravity, collisions), gold and exit
progression, valid/invalid digging, hole lifetime and regeneration, guards
falling in and escaping holes, entombment, contact death, deterministic guard
movement and tie-breaks, guard gold carry/drop, restart, pause, progression,
victory, score/lives, and a module/CLI smoke test.
