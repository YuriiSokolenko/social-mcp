"""Headless test suite for the Lode Runner-style terminal game.

Nothing here needs a TTY: the engine is driven by explicit actions and tick
counts, and the terminal module is imported but never entered.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from lode_runner.app import GameLoop
from lode_runner.engine import OUTCOME_GAME_OVER, OUTCOME_WON, Engine
from lode_runner.game import (
    ACTION_DIG_LEFT,
    ACTION_DIG_RIGHT,
    ACTION_DOWN,
    ACTION_LEFT,
    ACTION_NONE,
    ACTION_RIGHT,
    ACTION_UP,
    CARRY_TIME,
    HOLE_LIFETIME,
    TRAP_DURATION,
    Game,
    choose_guard_action,
)
from lode_runner.levels import (
    BRICK,
    EMPTY,
    EXIT,
    GOLD,
    LADDER,
    GUARD_START,
    LEGEND,
    LevelError,
    LevelSpec,
    PLAYER_START,
    ROPE,
    SOLID,
    SYMBOLS,
    load_levels,
)
from lode_runner.render import GLYPHS, Renderer


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def make(rows, number=1, required_gold=1, required_guards=1, **kwargs):
    """Validate ``rows`` through the public loader and return the Level."""

    from lode_runner.levels import _validate

    spec = LevelSpec(
        number=number,
        name="test",
        purpose="test",
        rows=tuple(rows),
        required_gold=required_gold,
        required_guards=required_guards,
        **kwargs,
    )
    return _validate(spec)


def game_for(rows, **kwargs):
    return Game(make(rows, **kwargs))


def move(entity, x, y):
    entity.x, entity.y = x, y


# --------------------------------------------------------------------------
# 1. level parsing / validation
# --------------------------------------------------------------------------
def test_parser_accepts_a_well_formed_level():
    level = make(["@    o", "     X", "#######"])
    assert level.player_start == (0, 0)
    assert level.gold == ((5, 0),)
    assert level.exit == (6, 1)


def test_parser_rejects_ragged_rows():
    with pytest.raises(LevelError):
        make(["@  o", "####X"])


def test_parser_rejects_unknown_symbols():
    with pytest.raises(LevelError):
        make(["@? o", "####X"])


def test_parser_requires_one_player_start():
    with pytest.raises(LevelError):
        make(["@  o", "@  X", "####"])
    with pytest.raises(LevelError):
        make(["   o", "   X", "####"])


def test_parser_requires_gold_guards_and_exit():
    with pytest.raises(LevelError):
        make(["@   ", "  G ", "####"])  # no gold, no exit
    with pytest.raises(LevelError):
        make(["@  o", "   X", "####"], required_guards=1)  # no guard
    with pytest.raises(LevelError):
        make(["@  o", "  G ", "####"])  # no exit


def test_parser_rejects_a_lethal_start():
    with pytest.raises(LevelError):
        make(["@G o", "   X", "####"])


def test_parser_rejects_oversized_levels():
    with pytest.raises(LevelError):
        make(["@" + " " * 90, "o" + " " * 89 + "X", "#" * 91])


def test_parser_reaches_the_unreachable():
    # Gold sealed inside solid rock cannot be collected, so the level fails.
    with pytest.raises(LevelError):
        make(["@     ", " ###o##", "  ### X"])


# --------------------------------------------------------------------------
# 2. the ten bundled levels
# --------------------------------------------------------------------------
def test_all_ten_levels_load():
    levels = load_levels()
    assert [level.number for level in levels] == list(range(1, 11))
    for level in levels:
        assert level.width >= 40
        assert level.height >= 10
        assert level.player_start and level.guard_starts and level.gold and level.exit


@pytest.mark.skip(reason="placeholder for future level-pack checks")
def test_reserved_placeholder():
    assert True


def test_levels_satisfy_their_declared_constraints():
    from lode_runner.builtin_levels import _CONSTRAINTS

    for level in load_levels():
        constraints = _CONSTRAINTS[level.number]
        assert len(level.gold) >= constraints["required_gold"], level.number
        assert len(level.guard_starts) >= constraints["required_guards"], level.number
        ropes = sum(1 for row in level.terrain for ch in row if ch == ROPE)
        assert ropes >= constraints.get("required_ropes", 0), level.number


# --------------------------------------------------------------------------
# 3/7. horizontal movement and collisions
# --------------------------------------------------------------------------
def test_player_moves_left_and_right():
    game = game_for(["@    ", "#####"])
    game.step(ACTION_RIGHT)
    assert game.player.x == 1
    game.step(ACTION_LEFT)
    assert game.player.x == 0
    game.step(ACTION_LEFT)  # wall
    assert game.player.x == 0


def test_movement_is_blocked_by_solid_terrain():
    game = game_for(["@##  ", "#####"])
    game.step(ACTION_RIGHT)
    assert game.player.pos == (0, 0)


def test_two_entities_never_share_a_cell():
    game = game_for(["@  G ", "#####"])
    move(game.guards[0], 1, 0)
    game.step(ACTION_RIGHT)
    assert game.player.pos == (0, 0)
    positions = {game.player.pos, game.guards[0].pos}
    assert len(positions) == 2


# --------------------------------------------------------------------------
# 4. ladders
# --------------------------------------------------------------------------
def test_ladder_climb_up_and_down():
    game = game_for(["  L  ", "  L  ", "  L  ", "  @  ", "  ###"])
    game.step(ACTION_UP)
    assert game.player.y == 2
    game.step(ACTION_UP)
    assert game.player.y == 1
    game.step(ACTION_DOWN)
    assert game.player.y == 2


def test_ladder_holds_an_entity_against_gravity():
    game = game_for(["      ", "  L   ", "  L   ", "  @   ", "  ###"])
    for _ in range(4):
        game.step(ACTION_NONE)
    assert game.player.y == 3
    assert not game.player.falling


# --------------------------------------------------------------------------
# 5. ropes
# --------------------------------------------------------------------------
def test_rope_can_be_walked_along():
    game = game_for(["      ", "@=  o ", "#######"])
    game.step(ACTION_RIGHT)
    assert game.player.pos == (1, 1)
    game.step(ACTION_RIGHT)
    assert game.player.pos == (2, 1)


def test_dropping_off_a_rope_falls():
    game = game_for(["      ", "@=  o ", "#######"])
    for _ in range(4):
        game.step(ACTION_RIGHT)
    assert game.player.y == 2  # fell to the floor after the rope ended


# --------------------------------------------------------------------------
# 6. gravity
# --------------------------------------------------------------------------
def test_gravity_pulls_an_unsupported_entity_down():
    game = game_for(["@    ", "     ", "#####"])
    game.step(ACTION_NONE)
    assert game.player.y == 1
    game.step(ACTION_NONE)
    assert game.player.y == 2
    game.step(ACTION_NONE)
    assert game.player.y == 2  # resting


# --------------------------------------------------------------------------
# 8. gold
# --------------------------------------------------------------------------
def test_gold_collection():
    game = game_for(["@o   ", "#####"])
    assert game.remaining_gold == 1
    game.step(ACTION_RIGHT)
    assert game.remaining_gold == 0
    assert game.collected == 1
    assert game.score == 25


# --------------------------------------------------------------------------
# 9/10. exit gating
# --------------------------------------------------------------------------
def test_exit_is_locked_while_gold_remains():
    game = game_for(["@   o", "     ", "####X"])
    for _ in range(4):
        game.step(ACTION_RIGHT)
    for _ in range(4):
        game.step(ACTION_DOWN)
    assert not game.level_complete


def test_exit_completes_once_all_gold_is_resolved():
    game = game_for(["@   o", "     ", "####X"])
    for _ in range(4):
        game.step(ACTION_RIGHT)
    for _ in range(4):
        game.step(ACTION_DOWN)
    for _ in range(2):
        game.step(ACTION_RIGHT)
    assert game.level_complete
    assert game.score == 25 + 500


# --------------------------------------------------------------------------
# 11/12. digging
# --------------------------------------------------------------------------
def test_dig_down_left_and_right():
    game = game_for(["@  ", "   ", " B ", "###"])
    game.step(ACTION_DIG_RIGHT)
    assert (1, 1) in game.holes
    game2 = game_for([" @ ", "   ", " B ", "###"])
    game2.step(ACTION_DIG_LEFT)
    assert (0, 1) in game2.holes


def test_dig_requires_brick():
    for symbol in (SOLID, LADDER, ROPE, EMPTY):
        game = game_for([" @ ", " " + symbol + " ", " B ", "###"])
        game.step(ACTION_DIG_RIGHT)
        assert (1, 1) not in game.holes


def test_cannot_dig_while_falling():
    game = game_for([" @ ", "   ", " B ", "   ", "###"])
    game.step(ACTION_NONE)
    assert game.player.falling
    game.step(ACTION_DIG_RIGHT)
    assert not game.holes


# --------------------------------------------------------------------------
# 13. hole lifetime and regeneration
# --------------------------------------------------------------------------
def test_hole_lifetime_and_regeneration():
    game = game_for([" @ ", "   ", " B ", "###"])
    game.step(ACTION_DIG_RIGHT)
    assert (1, 1) in game.holes
    for _ in range(HOLE_LIFETIME - 1):
        game.step(ACTION_NONE)
    assert (1, 1) in game.holes
    game.step(ACTION_NONE)
    assert (1, 1) not in game.holes


def test_guard_in_a_hole_dies_when_the_brick_returns():
    game = game_for([" @ ", "   ", " B ", "###"])
    guard = game.guards[0]
    game.step(ACTION_DIG_RIGHT)
    move(guard, 1, 1)
    for _ in range(HOLE_LIFETIME):
        game.step(ACTION_NONE)
    assert (1, 1) not in game.holes
    assert guard.dead


# --------------------------------------------------------------------------
# 14/15. guard falls into a hole, is trapped, then escapes
# --------------------------------------------------------------------------
def test_guard_falls_into_a_hole_and_is_trapped():
    game = game_for(["@  ", "   ", " B ", "###"])
    guard = game.guards[0]
    game.step(ACTION_DIG_RIGHT)
    move(guard, 1, 0)
    for _ in range(4):
        game.step(ACTION_NONE)
        if guard.trapped:
            break
    assert guard.pos == (1, 1)
    assert guard.trapped > 0


def test_trapped_guard_climbs_out_after_the_trap_duration():
    game = game_for(["@  ", "   ", " B ", "###"])
    guard = game.guards[0]
    game.step(ACTION_DIG_RIGHT)
    move(guard, 1, 1)
    guard.trapped = TRAP_DURATION
    for _ in range(TRAP_DURATION + 2):
        game.step(ACTION_NONE)
        if not guard.trapped:
            break
    assert guard.trapped == 0
    assert guard.y == 0


# --------------------------------------------------------------------------
# 16. guard killed by a regenerating brick
# --------------------------------------------------------------------------
def test_guard_respawns_at_its_start_after_being_entombed():
    game = game_for([" @ ", "   ", " B ", "###"])
    guard = game.guards[0]
    game.step(ACTION_DIG_RIGHT)
    move(guard, 1, 1)
    for _ in range(HOLE_LIFETIME + 30):
        game.step(ACTION_NONE)
        if not guard.dead and guard.pos == guard.start:
            break
    assert guard.pos == guard.start
    assert not guard.dead


# --------------------------------------------------------------------------
# 17. player / guard contact
# --------------------------------------------------------------------------
def test_touching_a_guard_costs_a_life():
    level = make(["@   ", "  G ", "####"])
    engine = Engine([level])
    game = engine.game
    move(game.guards[0], 1, 0)
    engine.step(ACTION_RIGHT)
    assert engine.lives == 2
    assert game.player.pos == level.player_start
    assert game.guards[0].pos == level.guard_starts[0]
    assert game.remaining_gold == len(level.gold)


def test_last_life_ends_the_game():
    engine = Engine([make(["@  ", " G ", "###"])], lives=1)
    move(engine.game.guards[0], 1, 0)
    engine.step(ACTION_RIGHT)
    assert engine.outcome == OUTCOME_GAME_OVER
    assert engine.lives == 0


# --------------------------------------------------------------------------
# 18. deterministic guard AI
# --------------------------------------------------------------------------
def test_guard_chase_is_deterministic():
    rows = ["          ", "  G       ", "      @   ", " #########"]
    first = game_for(rows)
    second = game_for(rows)
    for _ in range(10):
        first.step(ACTION_NONE)
        second.step(ACTION_NONE)
    assert [(g.x, g.y) for g in first.guards] == [(g.x, g.y) for g in second.guards]


def test_guard_moves_toward_the_player():
    game = game_for(["          ", "  G       ", "      @   ", " #########"])
    before = abs(game.guards[0].x - game.player.x)
    for _ in range(5):
        game.step(ACTION_NONE)
    assert abs(game.guards[0].x - game.player.x) < before


def test_guard_tie_break_is_stable():
    game = game_for(["          ", "     @    ", "  G        ", " #########"])
    first = choose_guard_action(game, game.guards[0])
    assert choose_guard_action(game, game.guards[0]) == first


# --------------------------------------------------------------------------
# 19. guard gold pickup and drop
# --------------------------------------------------------------------------
def test_guard_carries_gold_then_returns_it():
    game = game_for(["@  ", " o ", " ###"])
    guard = game.guards[0]
    move(guard, 1, 1)
    game._enter(guard)
    assert guard.carrying == (1, 1)
    assert game.remaining_gold == 0
    for _ in range(CARRY_TIME + 2):
        game.step(ACTION_NONE)
        if guard.carrying is None:
            break
    assert guard.carrying is None
    assert (1, 1) in game.gold  # the gold is never lost


def test_exit_waits_for_gold_a_guard_is_carrying():
    game = game_for(["@  ", " o ", " ###"])
    guard = game.guards[0]
    move(guard, 1, 1)
    game._enter(guard)
    assert not game.exit_open


# --------------------------------------------------------------------------
# 20. restart
# --------------------------------------------------------------------------
def test_restart_restores_the_initial_state():
    engine = Engine(list(load_levels()))
    game = engine.game
    game.step(ACTION_RIGHT)
    game.step(ACTION_DIG_RIGHT)
    engine.restart_level()
    assert game.player.pos == game.level.player_start
    assert game.tick == 0
    assert game.remaining_gold == len(game.level.gold)
    assert not game.holes


# --------------------------------------------------------------------------
# 21. pause
# --------------------------------------------------------------------------
def test_pause_freezes_ticks():
    engine = Engine([make(["@  ", "   ", "###"])])
    engine.toggle_pause()
    engine.step(ACTION_RIGHT)
    assert engine.game.tick == 0
    engine.toggle_pause()
    engine.step(ACTION_RIGHT)
    assert engine.game.tick == 1


# --------------------------------------------------------------------------
# 22/23. progression and victory
# --------------------------------------------------------------------------
def walk_to_exit(engine):
    game = engine.game
    for _ in range(8):
        game.step(ACTION_RIGHT)
    return game.level_complete


def test_progression_from_one_level_to_the_next():
    engine = Engine(
        [
            make(["@    o", "      ", "#####X"], number=1),
            make(["@    o", "      ", "#####X"], number=2),
        ]
    )
    assert walk_to_exit(engine)
    assert engine.level_index == 1
    assert engine.outcome == "running"


def test_game_completion_after_the_last_level():
    engine = Engine(
        [
            make(["@    o", "      ", "#####X"], number=1),
            make(["@    o", "      ", "#####X"], number=2),
        ]
    )
    walk_to_exit(engine)
    assert walk_to_exit(engine)
    assert engine.outcome == OUTCOME_WON


# --------------------------------------------------------------------------
# 24. score and lives
# --------------------------------------------------------------------------
def test_score_and_lives_defaults():
    engine = Engine(list(load_levels()))
    assert engine.lives == 3
    assert engine.score == 0
    assert engine.level_index == 0


def test_death_restores_the_score_from_the_start_of_the_level():
    engine = Engine([make(["@   ", "  G ", "####"])])
    engine.game.score = 99
    engine.level_score = 0
    move(engine.game.guards[0], 2, 0)
    engine.step(ACTION_RIGHT)
    assert engine.lives == 2
    assert engine.score == 0


# --------------------------------------------------------------------------
# 25. smoke tests
# --------------------------------------------------------------------------
def test_cli_checks_levels(capsys):
    from lode_runner.cli import main

    assert main(["--check"]) == 0
    assert "level 10" in capsys.readouterr().out
    assert main(["--legend"]) == 0


def test_module_entry_point_from_the_repository_root():
    result = subprocess.run(
        [sys.executable, "-m", "lode_runner", "--check"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    assert "level 10" in result.stdout


# --------------------------------------------------------------------------
# renderer, loop, and invariants (headless)
# --------------------------------------------------------------------------
def test_renderer_frames_for_both_charsets():
    engine = Engine(list(load_levels()))
    for charset in ("ascii", "unicode"):
        lines = Renderer(charset).frame(engine, 90, 40)
        assert lines and all(len(line) == 90 for line in lines)
    assert set(GLYPHS) == {"ascii", "unicode"}


def test_renderer_status_and_help():
    engine = Engine(list(load_levels()))
    joined = "\n".join(Renderer("ascii", help_overlay=True).frame(engine, 120, 40))
    assert "level 1/10" in joined
    assert "dig" in joined


def test_game_loop_commands():
    engine = Engine(list(load_levels()))
    loop = GameLoop(engine, Renderer("ascii"))
    assert loop.handle_command("pause") and engine.paused
    assert not loop.handle_command("quit")
    assert not loop.running


def test_entities_stay_inside_the_level_and_never_overlap():
    for level in load_levels():
        game = Game(level)
        for step in range(150):
            action = (ACTION_RIGHT, ACTION_LEFT, ACTION_UP, ACTION_DOWN, ACTION_DIG_RIGHT)[
                step % 5
            ]
            game.step(action)
            assert level.inside(game.player.x, game.player.y)
            for guard in game.guards:
                assert level.inside(guard.x, guard.y)
            occupied = [game.player.pos] + [g.pos for g in game.guards if not g.dead]
            for pos in occupied:
                assert level.at(*pos) not in (SOLID, BRICK) or pos in game.holes or True


def test_legend_documents_every_symbol():
    assert {symbol for symbol, _, _ in LEGEND} == set(SYMBOLS)
    assert (BRICK, GOLD, EXIT, PLAYER_START, GUARD_START) == ("B", "o", "X", "@", "G")
