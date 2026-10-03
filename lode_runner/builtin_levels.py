"""The ten handcrafted level maps and their design constraints.

Level authoring
---------------
A level is described declaratively (:func:`build_level`): a ground row, extra
floors of brick (``B``) or solid rock (``#``), ladders (``L``), ropes (``=``),
gold chests (``o``), guards (``G``), the player (``@``), and the exit (``X``).
``build_level`` renders that description into a rectangular character map.

Gold chests are drawn one row *above* the floor they rest on, which is also how
the reachability check in ``levels`` reads them (a chest is standable ground).
``levels.load_levels`` validates every map - symbols, shape, minimum terminal
size, exactly one player start, required gold / guard / rope counts, a non-lethal
start - and proves a completion route exists: walking, or after opening at most
two brick holes for the levels that are designed around digging.
"""

from __future__ import annotations

import random

from .levels import LevelSpec

WIDTH = 52
HEIGHT = 14

_EMPTY = " "
_BRICK = "B"
_SOLID = "#"
_LADDER = "L"
_ROPE = "="


def build_level(
    width: int,
    height: int,
    ground_y: int,
    *,
    floors: list[tuple[int, str]] | None = None,
    ropes: list[tuple[int, int, int]] | None = None,
    ladders: list[tuple[int, int, int]] | None = None,
    gold: list[tuple[int, int]] | None = None,
    guards: list[tuple[int, int]] | None = None,
    player: tuple[int, int] = (2, 0),
    exit_cell: tuple[int, int] = (0, 0),
    blockers: list[tuple[int, int, int]] | None = None,
) -> list[str]:
    """Render a level description into a rectangular character map."""

    grid = [[" "] * width for _ in range(height)]

    for x in range(width):
        grid[ground_y][x] = _BRICK

    for y, kind in floors or ():
        tile = _BRICK if kind == _BRICK else _SOLID
        for x in range(width):
            grid[y][x] = tile

    for x0, y0, length in blockers or ():
        for x in range(x0, x0 + length):
            if 0 <= x < width and 0 <= y0 < height:
                grid[y0][x] = _SOLID

    for x0, y0, length in ropes or ():
        for x in range(x0, x0 + length):
            if 0 <= x < width and 0 <= y0 < height:
                grid[y0][x] = _ROPE

    for x, top, bottom in ladders or ():
        for y in range(top, bottom + 1):
            if 0 <= y < height and 0 <= x < width:
                grid[y][x] = _LADDER

    for x, y in gold or ():
        if 0 <= x < width and 0 <= y < height:
            grid[y][x] = "o"

    for x, y in guards or ():
        grid[y][x] = "G"

    px, py = player
    grid[py][px] = "@"
    ex, ey = exit_cell
    grid[ey][ex] = "X"

    return ["".join(row) for row in grid]


def _row(rng: random.Random, count: int, lo: int, hi: int) -> list[int]:
    """``count`` distinct columns spread across ``[lo, hi]``."""

    return sorted(rng.sample(range(lo, hi + 1), k=count))


def _on_top(rows: list[str], columns: list[int], floor_y: int) -> list[tuple[int, int]]:
    """Gold chests resting on the floor row ``floor_y``."""

    return [(x, floor_y - 1) for x in columns if 0 < x < len(rows[0]) and 0 < floor_y < len(rows)]


def _level_one() -> tuple[list[str], dict[str, object]]:
    rng = random.Random(1)
    rows = build_level(
        WIDTH,
        HEIGHT,
        ground_y=11,
        floors=[(6, _BRICK)],
        ladders=[(8, 7, 10), (22, 7, 10), (36, 7, 10), (46, 7, 10)],
        guards=[(28, 10)],
        player=(2, 10),
        exit_cell=(49, 10),
    )
    rows = _place(rows, _on_top(rows, _row(rng, 4, 6, 20), 5))
    rows = _place(rows, _on_top(rows, _row(rng, 4, 26, 44), 5))
    rows = _place(rows, _on_top(rows, _row(rng, 3, 6, 44), 10))
    return rows, {
        "required_gold": 5,
        "required_guards": 1,
        "required_ropes": 0,
        "require_dig": False,
    }


def _level_two() -> tuple[list[str], dict[str, object]]:
    rng = random.Random(2)
    rows = build_level(
        WIDTH,
        HEIGHT,
        ground_y=11,
        floors=[(7, _BRICK)],
        ladders=[(6, 8, 10), (16, 8, 10), (30, 8, 10)],
        guards=[(12, 10), (24, 10)],
        player=(2, 10),
        exit_cell=(50, 10),
        blockers=[(36, 9, 16)],
    )
    rows = _place(rows, _on_top(rows, _row(rng, 4, 4, 30), 6))
    rows = _place(rows, _on_top(rows, _row(rng, 3, 40, 50), 10))
    # The right-hand pocket (rows 9..10 beyond column 36) is sealed by rock, so
    # reaching its gold and the exit needs one dig in the brick floor below.
    return rows, {
        "required_gold": 6,
        "required_guards": 2,
        "required_ropes": 0,
        "require_dig": True,
    }


def _level_three() -> tuple[list[str], dict[str, object]]:
    rng = random.Random(3)
    rows = build_level(
        WIDTH,
        HEIGHT,
        ground_y=12,
        floors=[(5, _BRICK)],
        ladders=[(6, 6, 11), (24, 6, 11), (44, 6, 11)],
        ropes=[(12, 9, 22)],
        guards=[(14, 11), (34, 11)],
        player=(2, 11),
        exit_cell=(50, 11),
    )
    rows = _place(rows, _on_top(rows, _row(rng, 4, 4, 46), 4))
    rows = _place(rows, _on_top(rows, _row(rng, 4, 14, 32), 8))
    rows = _place(rows, _on_top(rows, _row(rng, 3, 4, 46), 11))
    return rows, {
        "required_gold": 7,
        "required_guards": 2,
        "required_ropes": 6,
        "require_dig": False,
    }


def _level_four() -> tuple[list[str], dict[str, object]]:
    rng = random.Random(4)
    rows = build_level(
        WIDTH,
        HEIGHT,
        ground_y=12,
        floors=[(6, _BRICK)],
        ladders=[(10, 7, 11), (30, 7, 11), (46, 7, 11)],
        guards=[(14, 11), (22, 11), (34, 11)],
        player=(2, 11),
        exit_cell=(50, 11),
        blockers=[(42, 10, 10)],
    )
    rows = _place(rows, _on_top(rows, _row(rng, 5, 4, 38), 5))
    rows = _place(rows, _on_top(rows, _row(rng, 5, 4, 38), 11))
    return rows, {
        "required_gold": 8,
        "required_guards": 3,
        "required_ropes": 0,
        "require_dig": True,
    }


def _level_five() -> tuple[list[str], dict[str, object]]:
    rng = random.Random(5)
    rows = build_level(
        WIDTH,
        HEIGHT,
        ground_y=12,
        floors=[(6, _BRICK)],
        ladders=[(6, 7, 11), (24, 7, 11), (44, 7, 11)],
        ropes=[(18, 9, 14)],
        guards=[(12, 11), (30, 11), (38, 11)],
        player=(2, 11),
        exit_cell=(50, 11),
    )
    rows = _place(rows, _on_top(rows, _row(rng, 5, 2, 20), 5))
    rows = _place(rows, _on_top(rows, _row(rng, 4, 26, 48), 11))
    rows = _place(rows, _on_top(rows, _row(rng, 3, 20, 32), 8))
    return rows, {
        "required_gold": 9,
        "required_guards": 3,
        "required_ropes": 4,
        "require_dig": False,
    }


def _level_six() -> tuple[list[str], dict[str, object]]:
    rng = random.Random(6)
    rows = build_level(
        WIDTH,
        HEIGHT,
        ground_y=12,
        floors=[(8, _BRICK), (4, _BRICK)],
        ladders=[(10, 5, 11), (38, 9, 11)],
        guards=[(14, 11), (22, 11), (30, 11), (26, 7)],
        player=(2, 11),
        exit_cell=(50, 11),
        blockers=[(42, 10, 10)],
    )
    rows = _place(rows, _on_top(rows, _row(rng, 4, 4, 38), 3))
    rows = _place(rows, _on_top(rows, _row(rng, 4, 4, 36), 7))
    rows = _place(rows, _on_top(rows, _row(rng, 4, 4, 38), 11))
    return rows, {
        "required_gold": 10,
        "required_guards": 4,
        "required_ropes": 0,
        "require_dig": True,
    }


def _level_seven() -> tuple[list[str], dict[str, object]]:
    rng = random.Random(7)
    rows = build_level(
        WIDTH,
        HEIGHT,
        ground_y=12,
        floors=[(6, _BRICK)],
        ladders=[(10, 7, 11), (24, 7, 11), (42, 7, 11)],
        guards=[(8, 11), (16, 11), (28, 11), (36, 11), (44, 11)],
        player=(2, 11),
        exit_cell=(50, 11),
    )
    rows = _place(rows, _on_top(rows, _row(rng, 6, 2, 48), 5))
    rows = _place(rows, _on_top(rows, _row(rng, 5, 2, 48), 11))
    return rows, {
        "required_gold": 11,
        "required_guards": 5,
        "required_ropes": 0,
        "require_dig": False,
    }


def _level_eight() -> tuple[list[str], dict[str, object]]:
    rng = random.Random(8)
    rows = build_level(
        WIDTH,
        HEIGHT,
        ground_y=12,
        floors=[(8, _BRICK)],
        ladders=[(6, 9, 11), (30, 9, 11)],
        ropes=[(18, 5, 10)],
        guards=[(10, 11), (24, 11), (32, 11), (40, 11)],
        player=(2, 11),
        exit_cell=(50, 11),
        blockers=[(42, 10, 10)],
    )
    rows = _place(rows, _on_top(rows, _row(rng, 5, 20, 34), 7))
    rows = _place(rows, _on_top(rows, _row(rng, 4, 2, 38), 11))
    rows = _place(rows, _on_top(rows, _row(rng, 3, 18, 30), 4))
    return rows, {
        "required_gold": 12,
        "required_guards": 5,
        "required_ropes": 4,
        "require_dig": True,
    }


def _level_nine() -> tuple[list[str], dict[str, object]]:
    rng = random.Random(9)
    rows = build_level(
        WIDTH,
        15,
        ground_y=14,
        floors=[(4, _BRICK), (8, _BRICK), (11, _BRICK)],
        ladders=[(6, 5, 13), (20, 5, 13), (34, 5, 13), (44, 5, 13)],
        guards=[(8, 13), (16, 13), (26, 13), (36, 13), (44, 13)],
        player=(2, 13),
        exit_cell=(50, 2),
    )
    rows = _place(rows, _on_top(rows, _row(rng, 4, 2, 48), 3))
    rows = _place(rows, _on_top(rows, _row(rng, 4, 2, 48), 7))
    rows = _place(rows, _on_top(rows, _row(rng, 3, 2, 48), 10))
    rows = _place(rows, _on_top(rows, _row(rng, 3, 2, 48), 13))
    return rows, {
        "required_gold": 13,
        "required_guards": 6,
        "required_ropes": 0,
        "require_dig": False,
    }


def _level_ten() -> tuple[list[str], dict[str, object]]:
    rng = random.Random(10)
    rows = build_level(
        WIDTH,
        15,
        ground_y=14,
        floors=[(4, _BRICK), (8, _BRICK), (11, _BRICK)],
        ladders=[(8, 5, 13), (22, 5, 13), (38, 5, 13), (46, 9, 13)],
        ropes=[(14, 6, 10)],
        guards=[(10, 13), (18, 13), (26, 13), (34, 13), (42, 13)],
        player=(2, 13),
        exit_cell=(50, 13),
        blockers=[(42, 12, 10)],
    )
    rows = _place(rows, _on_top(rows, _row(rng, 5, 2, 38), 3))
    rows = _place(rows, _on_top(rows, _row(rng, 5, 2, 38), 7))
    rows = _place(rows, _on_top(rows, _row(rng, 5, 2, 38), 10))
    rows = _place(rows, _on_top(rows, _row(rng, 3, 2, 38), 13))
    return rows, {
        "required_gold": 15,
        "required_guards": 7,
        "required_ropes": 4,
        "require_dig": True,
    }


def _place(rows: list[str], chests: list[tuple[int, int]]) -> list[str]:
    for x, y in chests:
        if 0 <= y < len(rows) and 0 <= x < len(rows[y]):
            rows[y] = rows[y][:x] + "o" + rows[y][x + 1 :]
    return rows


_BUILDERS = (
    _level_one,
    _level_two,
    _level_three,
    _level_four,
    _level_five,
    _level_six,
    _level_seven,
    _level_eight,
    _level_nine,
    _level_ten,
)

_NAMES = (
    ("First Run", "movement, ladders, one guard, basic gold collection"),
    ("First Dig", "completion requires at least one successful dig"),
    ("Rope Walk", "ropes, hanging, and dropping from a rope"),
    ("Trap Lesson", "trapping a pursuing guard in a dug hole"),
    ("Split Tower", "vertical navigation with ladders plus ropes across two halves"),
    ("False Floors", "choosing the correct dig site among decoys"),
    ("Guard Traffic", "shared corridors and multiple escape routes"),
    ("The Vault", "multi-step vault objective requiring rope use and digging"),
    ("Vertical Maze", "tall ladder maze with drop/dig escapes and a final ascent"),
    ("Final Gauntlet", "all systems combined, difficult but deterministic"),
)


def level_specs() -> tuple[LevelSpec, ...]:
    specs = []
    for index, builder in enumerate(_BUILDERS):
        rows, constraints = builder()
        name, purpose = _NAMES[index]
        specs.append(
            LevelSpec(
                number=index + 1,
                name=name,
                purpose=purpose,
                rows=tuple(rows),
                **constraints,
            )
        )
    return tuple(specs)
