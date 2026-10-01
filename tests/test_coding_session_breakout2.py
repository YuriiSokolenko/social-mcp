"""Pytest tests for :mod:`coding_session_breakout2`.

These tests exercise the deterministic game logic (state, movement,
collisions, scoring, lives, win/game-over/restart transitions) without a
terminal. Curses rendering is intentionally not invoked.
"""

import os
import re
import sys

import pytest

# Ensure the repository root (where coding_session_breakout2.py lives) is
# importable regardless of how pytest is invoked.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import coding_session_breakout2 as brk  # noqa: E402
from coding_session_breakout2 import (  # noqa: E402
    MAX_LIVES,
    PADDLE_ROW,
    PROJECT_NAME,
    Ball,
    Breakout,
    Paddle,
    banner_lines,
)


@pytest.fixture
def game() -> Breakout:
    g = Breakout()
    g.center_paddle()
    return g


# ---------------------------------------------------------------------------
# Project name / banner
# ---------------------------------------------------------------------------

def _read_pyproject_name() -> str:
    with open("pyproject.toml", encoding="utf-8") as fh:
        text = fh.read()
    match = re.search(r'^name\s*=\s*"([^"]+)"\s*$', text, re.MULTILINE)
    assert match is not None, "could not find [project].name in pyproject.toml"
    return match.group(1)


def test_project_name_constant_matches_pyproject():
    assert PROJECT_NAME == _read_pyproject_name()


def test_banner_lines_contain_project_name():
    lines = banner_lines()
    assert len(lines) == 3
    joined = "\n".join(lines)
    # The banner must contain the uppercased project name.
    assert PROJECT_NAME.upper() in joined


# ---------------------------------------------------------------------------
# Paddle movement and bounds
# ---------------------------------------------------------------------------

def test_paddle_starts_centered(game):
    expected = (game.width - game.paddle.width) // 2
    assert game.paddle.left == expected


def test_move_paddle_left_and_right(game):
    start = game.paddle.left
    game.move_paddle(-2)
    assert game.paddle.left == start - 2
    game.move_paddle(2)
    assert game.paddle.left == start


def test_move_paddle_clamped_to_left_border(game):
    game.paddle.left = game.width // 2
    for _ in range(1000):
        game.move_paddle(-10)
    assert game.paddle.left >= 1  # LEFT_BORDER


def test_move_paddle_clamped_to_right_border(game):
    game.paddle.left = game.width // 2
    for _ in range(1000):
        game.move_paddle(10)
    right_edge = game.paddle_left() + game.paddle.width - 1
    assert right_edge <= brk.RIGHT_BORDER


def test_paddle_right_helper(game):
    assert game.paddle_right() == game.paddle.left + game.paddle.width - 1


def test_move_paddle_noop_when_game_ended(game):
    game.game_over = True
    start = game.paddle.left
    game.move_paddle(-2)
    assert game.paddle.left == start


# ---------------------------------------------------------------------------
# Serving & wall bounces
# ---------------------------------------------------------------------------

def test_initial_ball_is_served(game):
    # First update launches the ball from rest.
    game.update()
    assert game.ball.active


def test_ball_bounces_off_left_wall(game):
    game.serve()
    game.ball.pos.x = 2
    game.ball.pos.y = 5
    game.ball.vel_x = -1
    game.ball.vel_y = 0
    game.update()
    assert game.ball.vel_x == 1
    assert game.ball.pos.x == brk.LEFT_BORDER


def test_ball_bounces_off_right_wall(game):
    game.serve()
    game.ball.pos.x = brk.RIGHT_BORDER - 1
    game.ball.pos.y = 5
    game.ball.vel_x = 1
    game.ball.vel_y = 0
    game.update()
    assert game.ball.vel_x == -1
    assert game.ball.pos.x == brk.RIGHT_BORDER


def test_ball_bounces_off_top_wall(game):
    game.serve()
    game.ball.pos.x = 10
    game.ball.pos.y = 2
    game.ball.vel_x = 0
    game.ball.vel_y = -1
    game.update()
    assert game.ball.vel_y == 1
    assert game.ball.pos.y == brk.TOP_BORDER


# ---------------------------------------------------------------------------
# Paddle bounce
# ---------------------------------------------------------------------------

def test_ball_bounces_off_paddle(game):
    game.serve()
    game.ball.pos.x = game.paddle_left() + game.paddle.width // 2
    # Start one row above the paddle; update() moves the ball onto the paddle
    # row, where the paddle-collision check fires.
    game.ball.pos.y = PADDLE_ROW - 1
    game.ball.vel_x = 0
    game.ball.vel_y = 1  # moving downward into the paddle
    game.update()
    assert game.ball.vel_y == -1


def test_ball_passes_below_missed(game):
    # Ball far from paddle horizontally should NOT collide on the paddle row
    # unless it is within the paddle's bounds; here we place it to the side.
    game.serve()
    game.ball.pos.x = 1  # far left, outside paddle
    game.ball.pos.y = PADDLE_ROW - 1
    game.ball.vel_x = 0
    game.ball.vel_y = 1
    game.update()
    # The paddle is centered (around width//2), so x=1 is well outside it.
    assert game.ball.vel_y == 1  # unchanged because no paddle hit


# ---------------------------------------------------------------------------
# Brick destruction with scoring
# ---------------------------------------------------------------------------

def test_game_has_bricks(game):
    assert len(game.bricks) > 0
    assert any(b.alive for b in game.bricks)


def test_brick_hit_destroys_and_scores(game):
    brick = game.bricks[0]
    assert brick.alive
    before = game.score
    game.serve()
    game.ball.pos.x = brick.x
    # Start one row below the brick so update() moves the ball onto the brick
    # row and the brick-collision check fires.
    game.ball.pos.y = brick.y + 1
    game.ball.vel_x = 0
    game.ball.vel_y = -1
    game.update()
    assert not brick.alive
    assert game.score == before + brk._brick_points(brick.hits)


def test_multiple_brick_hits_score_up(game):
    # Destroy every brick one by one by placing the ball one row below each.
    game.serve()
    total = 0
    for brick in game.bricks:
        game.ball.pos.x = brick.x
        game.ball.pos.y = brick.y + 1
        game.ball.vel_x = 0
        game.ball.vel_y = -1
        # Temporarily clear win state so update keeps running.
        game.won = False
        game.update()
        if not brick.alive:
            total += brk._brick_points(brick.hits)
    alive_after = sum(1 for b in game.bricks if b.alive)
    assert alive_after == 0
    assert game.score == total


def test_render_lines_show_no_brick_after_hit(game):
    brick = game.bricks[0]
    game.serve()
    game.ball.pos.x = brick.x
    game.ball.pos.y = brick.y + 1
    game.ball.vel_x = 0
    game.ball.vel_y = -1
    game.update()
    # The brick's cell should no longer contain BRICK_CHAR.
    row = game.render_lines()[brick.y]
    assert row[brick.x] != brk.BRICK_CHAR


# ---------------------------------------------------------------------------
# Losing a life
# ---------------------------------------------------------------------------

def test_losing_ball_costs_life(game):
    game.serve()
    game.ball.pos.x = game.paddle_left() + 2
    game.ball.pos.y = game.height - 1
    game.ball.vel_x = 0
    game.ball.vel_y = 1
    game.update()
    assert game.lives == MAX_LIVES - 1


def test_losing_last_life_is_game_over(game):
    game.serve()
    # Force the ball below the bottom border repeatedly until lives run out.
    for _ in range(MAX_LIVES):
        game.ball.pos.x = game.paddle_left() + 2
        game.ball.pos.y = game.height - 1
        game.ball.vel_x = 0
        game.ball.vel_y = 1
        game.update()
    assert game.lives == 0
    assert game.game_over


def test_ball_resets_after_life_loss(game):
    game.serve()
    game.ball.pos.x = game.paddle_left() + 2
    game.ball.pos.y = game.height - 1
    game.ball.vel_x = 0
    game.ball.vel_y = 1
    game.update()
    # Ball should be back on the paddle, ready to serve again.
    assert game.ball.pos.y == PADDLE_ROW
    assert game.ball.vel_x == 0
    assert game.ball.vel_y == 0


# ---------------------------------------------------------------------------
# Win / game-over states
# ---------------------------------------------------------------------------

def test_win_when_all_bricks_destroyed(game):
    game.serve()
    game.won = False
    for brick in game.bricks:
        game.ball.pos.x = brick.x
        game.ball.pos.y = brick.y + 1
        game.ball.vel_x = 0
        game.ball.vel_y = -1
        game.update()
    assert game.won is True


def test_game_over_prevents_further_movement(game):
    game.game_over = True
    before = game.ball.pos.x
    game.update()
    assert game.ball.pos.x == before


def test_win_prevents_further_movement(game):
    game.won = True
    before = game.ball.pos.x
    game.update()
    assert game.ball.pos.x == before


# ---------------------------------------------------------------------------
# Restart
# ---------------------------------------------------------------------------

def test_restart_clears_state(game):
    # Put the game into a win state.
    game.serve()
    game.won = False
    for brick in game.bricks:
        game.ball.pos.x = brick.x
        game.ball.pos.y = brick.y + 1
        game.ball.vel_x = 0
        game.ball.vel_y = -1
        game.update()
    assert game.won

    game.restart()
    assert not game.won
    assert not game.game_over
    assert game.score == 0
    assert game.lives == MAX_LIVES
    assert all(b.alive for b in game.bricks)
    assert game.ball.vel_x == 0
    assert game.ball.vel_y == 0


def test_restart_resets_paddle_and_bricks(game):
    # Move paddle to a border and destroy some bricks.
    game.move_paddle(100)
    saved_left = game.paddle.left
    game.restart()
    assert game.paddle.left != saved_left
    assert game.paddle.left == (game.width - game.paddle.width) // 2
    assert len(game.bricks) == len(Breakout().bricks)


# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------

def test_render_lines_shape(game):
    lines = game.render_lines()
    assert len(lines) == game.height
    for line in lines:
        assert len(line) == game.width


def test_render_lines_show_paddle_and_borders(game):
    game.serve()
    lines = game.render_lines()
    # Top and bottom border rows should be present.
    assert "-" in lines[brk.TOP_BORDER]
    assert "-" in lines[brk.BOTTOM_BORDER]
    # Paddle row must contain the paddle char.
    assert brk.PADDLE_CHAR in lines[PADDLE_ROW]
    # Ball char must be present.
    ball_chars = sum(row.count(brk.BALL_CHAR) for row in lines)
    assert ball_chars == 1


# ---------------------------------------------------------------------------
# Small terminal handling / terminal restoration
# ---------------------------------------------------------------------------

def test_min_terminal_constants_exist():
    assert brk.MIN_TERMINAL_HEIGHT > 0
    assert brk.MIN_TERMINAL_WIDTH > 0


# ---------------------------------------------------------------------------
# Data classes sanity
# ---------------------------------------------------------------------------

def test_paddle_top_returns_constant_row():
    p = Paddle(left=0)
    assert p.top() == PADDLE_ROW
    assert p.right() == p.left + p.width - 1


def test_ball_dataclass_defaults():
    b = Ball()
    assert b.vel_x == 0
    assert b.vel_y == 0
