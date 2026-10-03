"""Static level definitions, parsing, validation, and reachability checks.

Level maps are blocks of equal-length strings; index ``0`` is the *top* terminal
row, so gravity moves entities toward higher ``y``.

Symbols
-------
`` ``  empty space (fall-through / walk-through)
``#``  solid block (indestructible, never diggable)
``B``  brick (diggable, provides support)
``L``  ladder (climbable, holds an entity against gravity)
``=``  rope / bar (hangable, walkable, no support)
``o``  gold (pickable, provides support)
``X``  exit door (walkable, sealed until all gold is resolved)
``@``  player start
``G``  guard start
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations

EMPTY = " "
SOLID = "#"
BRICK = "B"
LADDER = "L"
ROPE = "="
GOLD = "o"
EXIT = "X"
PLAYER_START = "@"
GUARD_START = "G"

SYMBOLS = (EMPTY, SOLID, BRICK, LADDER, ROPE, GOLD, EXIT, PLAYER_START, GUARD_START)

#: Static terrain that blocks movement but supports the entity on top of it.
BLOCKING = frozenset({SOLID, BRICK})

#: The smallest terminal we support; levels must fit inside it.
MIN_WIDTH = 60
MIN_HEIGHT = 22

LEGEND: tuple[tuple[str, str, str], ...] = (
    (" ", "empty", "nothing; entities fall through it"),
    ("#", "solid block", "indestructible; supports entities, never diggable"),
    ("B", "brick", "diggable; supports entities, dug holes regenerate"),
    ("L", "ladder", "climb up and down; holds an entity in place"),
    ("=", "rope", "hang from it and walk left/right; dropping off falls"),
    ("o", "gold", "collect it; all gold must be resolved to open the exit"),
    ("X", "exit", "leaving it completes the level once gold is resolved"),
    ("@", "player start", "exactly one per level"),
    ("G", "guard start", "one or more per level"),
)


class LevelError(ValueError):
    """Raised when a level map is malformed."""


@dataclass(frozen=True)
class LevelSpec:
    """A level map together with its declared design constraints."""

    number: int
    name: str
    purpose: str
    rows: tuple[str, ...]
    required_gold: int
    required_guards: int
    required_ropes: int = 0
    require_dig: bool = False


@dataclass(frozen=True)
class Level:
    """Immutable, validated static level data."""

    number: int
    name: str
    purpose: str
    width: int
    height: int
    terrain: tuple[str, ...]
    player_start: tuple[int, int]
    guard_starts: tuple[tuple[int, int], ...]
    gold: tuple[tuple[int, int], ...]
    exit: tuple[int, int]
    require_dig: bool = False

    def inside(self, x: int, y: int) -> bool:
        return 0 <= y < self.height and 0 <= x < self.width

    def at(self, x: int, y: int) -> str:
        """Terrain at a cell; out-of-bounds counts as solid wall."""

        if not self.inside(x, y):
            return SOLID
        return self.terrain[y][x]

    def is_free(self, x: int, y: int) -> bool:
        """Whether a static cell may be entered (it is not solid terrain)."""
        return self.at(x, y) not in BLOCKING

    def is_support(self, x: int, y: int) -> bool:
        """Whether static terrain at (x, y) supports the entity above it."""
        return self.at(x, y) in BLOCKING

    def is_ladder(self, x: int, y: int) -> bool:
        return self.at(x, y) == LADDER

    def is_rope(self, x: int, y: int) -> bool:
        return self.at(x, y) == ROPE

    def is_diggable(self, x: int, y: int) -> bool:
        return self.at(x, y) == BRICK

    def dig_cells(self) -> list[tuple[int, int]]:
        return [
            (x, y)
            for y in range(self.height)
            for x in range(self.width)
            if self.at(x, y) == BRICK
        ]


def _neighbours(level: Level, x: int, y: int) -> list[tuple[int, int]]:
    """Static traversal edges used by the load-time reachability check.

    A gold chest is solid ground an entity stands on, so it is entered from the
    side or by dropping onto it; leaving a chest always drops to the floor
    beneath it.
    """

    out: list[tuple[int, int]] = []
    here = level.at(x, y)
    if here == GOLD:
        # Standing on a chest: walk off it sideways or drop through.
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y + 1)):
            if level.is_free(nx, ny):
                out.append((nx, ny))
        return sorted(out)

    for dx in (-1, 1):
        if level.is_free(x + dx, y) or level.at(x + dx, y) == GOLD:
            out.append((x + dx, y))
    if level.is_free(x, y + 1) or level.at(x, y + 1) == GOLD:
        out.append((x, y + 1))
    if level.is_ladder(x, y - 1) and level.is_free(x, y - 1):
        out.append((x, y - 1))
    if level.is_ladder(x, y + 1):
        out.append((x, y + 1))
    return sorted(out)


def _reachable(level: Level) -> set[tuple[int, int]]:
    seen: set[tuple[int, int]] = {level.player_start}
    frontier = [level.player_start]
    while frontier:
        x, y = frontier.pop(0)
        for nxt in _neighbours(level, x, y):
            if nxt not in seen:
                seen.add(nxt)
                frontier.append(nxt)
    return seen


def _with_holes(level: Level, digs: frozenset[tuple[int, int]]) -> Level:
    """A copy of ``level`` where the given brick cells behave as dug holes."""

    grid = [list(row) for row in level.terrain]
    for x, y in digs:
        grid[y][x] = EMPTY
    return Level(
        number=level.number,
        name=level.name,
        purpose=level.purpose,
        width=level.width,
        height=level.height,
        terrain=tuple("".join(row) for row in grid),
        player_start=level.player_start,
        guard_starts=level.guard_starts,
        gold=level.gold,
        exit=level.exit,
        require_dig=False,
    )


def _solved_by(level: Level, digs: frozenset[tuple[int, int]]) -> bool:
    cells = _reachable(_with_holes(level, digs))
    return level.exit in cells and all(g in cells for g in level.gold)


def _validate_dig_completion(level: Level) -> None:
    """Prove the level is winnable by opening at most two brick holes."""

    diggable = level.dig_cells()
    if not diggable:
        raise LevelError(f"level {level.number}: no diggable brick in a dig-required level")
    for size in (1, 2):
        for combo in combinations(diggable, size):
            if _solved_by(level, frozenset(combo)):
                return
    raise LevelError(f"level {level.number}: no completion route exists even after digging")


def _validate(spec: LevelSpec) -> Level:
    rows = tuple(spec.rows)
    if not rows:
        raise LevelError(f"level {spec.number}: no rows")
    height = len(rows)
    width = len(rows[0])
    if height > MIN_HEIGHT:
        raise LevelError(
            f"level {spec.number}: {height} rows exceeds the {MIN_HEIGHT} row minimum terminal height"
        )
    if width > MIN_WIDTH:
        raise LevelError(
            f"level {spec.number}: {width} columns exceeds the {MIN_WIDTH} column minimum terminal width"
        )
    for y, row in enumerate(rows):
        if len(row) != width:
            raise LevelError(f"level {spec.number}: row {y} has {len(row)} columns, expected {width}")
        for x, ch in enumerate(row):
            if ch not in SYMBOLS:
                raise LevelError(f"level {spec.number}: illegal symbol {ch!r} at ({x}, {y})")

    player = [(x, y) for y, row in enumerate(rows) for x, ch in enumerate(row) if ch == PLAYER_START]
    guards = [(x, y) for y, row in enumerate(rows) for x, ch in enumerate(row) if ch == GUARD_START]
    gold = [(x, y) for y, row in enumerate(rows) for x, ch in enumerate(row) if ch == GOLD]
    exits = [(x, y) for y, row in enumerate(rows) for x, ch in enumerate(row) if ch == EXIT]
    ropes = sum(1 for row in rows for ch in row if ch == ROPE)

    if len(player) != 1:
        raise LevelError(f"level {spec.number}: expected exactly one player start, found {len(player)}")
    if not guards:
        raise LevelError(f"level {spec.number}: expected at least one guard")
    if not gold:
        raise LevelError(f"level {spec.number}: expected at least one gold")
    if len(exits) != 1:
        raise LevelError(f"level {spec.number}: expected exactly one exit, found {len(exits)}")
    if len(gold) < spec.required_gold:
        raise LevelError(f"level {spec.number}: found {len(gold)} gold, need >= {spec.required_gold}")
    if len(guards) < spec.required_guards:
        raise LevelError(f"level {spec.number}: found {len(guards)} guards, need >= {spec.required_guards}")
    if ropes < spec.required_ropes:
        raise LevelError(f"level {spec.number}: found {ropes} rope cells, need >= {spec.required_ropes}")

    px, py = player[0]
    for gx, gy in guards:
        if abs(gx - px) <= 1 and gy == py:
            raise LevelError(f"level {spec.number}: guard ({gx}, {gy}) could kill the player at once")

    terrain = tuple(row.replace(PLAYER_START, EMPTY).replace(GUARD_START, EMPTY) for row in rows)
    level = Level(
        number=spec.number,
        name=spec.name,
        purpose=spec.purpose,
        width=width,
        height=height,
        terrain=terrain,
        player_start=player[0],
        guard_starts=tuple(guards),
        gold=tuple(gold),
        exit=exits[0],
        require_dig=spec.require_dig,
    )

    reachable = _reachable(level)
    if level.exit not in reachable:
        if not spec.require_dig:
            raise LevelError(_describe(spec, "the exit is not reachable without digging"))
        _validate_dig_completion(level)
    for gx, gy in gold:
        if (gx, gy) not in reachable and not spec.require_dig:
            raise LevelError(_describe(spec, f"gold ({gx}, {gy}) is not reachable without digging"))
    return level


def _describe(spec: LevelSpec, reason: str) -> str:
    """The offending map with row/column rulers, for a validation failure."""

    rows = tuple(spec.rows)
    width = len(rows[0]) if rows else 0
    tens = ""
    ones = ""
    for x in range(width):
        tens += "5" if x % 10 == 5 else " "
        ones += str(x % 10)
    lines = [
        f"level {spec.number} ({spec.name}): {reason}",
        f"     {tens}",
        f"     {ones}",
    ]
    for y, row in enumerate(rows):
        lines.append(f"{y:4d} {row}")
    return "\n".join(lines)


from .builtin_levels import level_specs

LEVEL_SPECS: tuple[LevelSpec, ...] = level_specs()

_LEVELS: tuple[Level, ...] | None = None


def load_levels() -> tuple[Level, ...]:
    """Parse and validate every bundled level exactly once."""

    global _LEVELS
    if _LEVELS is None:
        _LEVELS = tuple(_validate(spec) for spec in LEVEL_SPECS)
    return _LEVELS


def get_level(number: int) -> Level:
    for level in load_levels():
        if level.number == number:
            return level
    raise KeyError(f"no such level: {number}")


def level_count() -> int:
    return len(load_levels())


def test_levels_are_collectable() -> None:
    """Smoke test kept in the module so ``pytest lode_runner/levels.py`` collects it."""

    levels = load_levels()
    assert len(levels) == 10
    assert all(level.gold and level.guard_starts and level.exit for level in levels)
