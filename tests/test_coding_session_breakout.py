"""Tests for the deterministic core of :mod:`coding_session_breakout`.

These tests never open a terminal: they exercise the game rules only.
"""

import tomllib
from pathlib import Path

import pytest

import coding_session_breakout as breakout
from coding_session_breakout import (
    BOARD,
    Board,
    Game,
    PROJECT_NAME,
    STATE_GAME_OVER,
    STATE_PLAYING,
    STATE_WIN,
)

PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


@pytest.fixture()
def game() -> Game:
    return Game(board=Board(width=40, height=22, paddle_width=7, rows=4, columns=8))


# --------------------------------------------------------------- the board --


def test_board_defaults_are_playable():
    board = Board()
    assert board.width == 40
    assert board.height == 22
    assert board.play_width == board.width - 2
    assert board.brick_rows == 4
    assert board.brick_cols == 8
    assert board.brick_cell_width * board.brick_cols <= board.play_width
    assert board.paddle_row == board.height - 3


def test_board_rejects_impossible_sizes():
    with pytest.raises(ValueError):
        Board(width=6)
    with pytest.raises(ValueError):
        Board(paddle_width=99)
    with pytest.raises(ValueError):
        Board(brick_cols=0)


# ------------------------------------------------------------ a fresh game --


def test_new_game_is_fully_populated_and_warm_upright():
    game = Game(board=Board(width=40, height=22, paddle_width=7, rows=4, columns=8))
    assert game.state == STATE_PLAYING
    assert game.score == 0
    assert game.lives == 3
    assert game.lives_remaining == 3
    assert game.bricks_left == 4 * 8
    assert game.bricks_destroyed == 0
    assert not game.exited
    # The paddle starts centred, and the serve goes upwards.
    assert game.paddle_x == (38 - 7) // 2
    assert game.ball.dy < 0


def test_paddle_cannot_pass_the_borders():
    game = Game(board=Board(width=30, height=20, paddle_width=5, rows=3, columns=6))
    for _ in range(50):
        game.move_paddle(-1)
    assert game.paddle_x == 0
    for _ in range(50):
        game.move_paddle(1)
    assert game.paddle_x == game.board.play_width - 5
    # Clamping keeps the whole paddle on screen.
    assert game.paddle_left == game.board.play_left
    assert game.paddle_right == game.board.play_right - 1


def set_paddle_centered(game: Game) -> None:
    game.paddle_x = game.board.play_width - game.board.paddle_width // 2
    game.paddle_x = (game.board.play_width - game.board.paddle_width) // 2


def aim_ball_at_paddle(game: Game) -> None:
    """Place the ball just above the middle of the paddle moving downwards."""
    game.ball.x = game.board.play_left + game.paddle_x + game.board.paddle_width / 2
    game.ball.y = game.board.paddle_row - 0.5
    game.ball.dx = 0.0
    game.ball.dy = 1.0


# ------------------------------------------------------------ wall bounces --


def test_ball_bounces_off_both_side_walls():
    game = Game(board=Board(width=30, height=20, paddle_width=5, rows=3, columns=6))
    game.ball.x = 1.1
    game.ball.y = 8.0
    game.ball.dx = -1.0
    game.ball.dy = 0.5
    game.step(1.0)
    assert game.ball.dx > 0  # bounced off the left wall
    assert game.state == STATE_PLAYING

    game.ball.x = 28.4
    game.ball.dx = 1.0
    game.step(1.0)
    assert game.ball.dx < 0  # bounced off the right wall


def test_ball_bounces_off_the_top_border():
    game = Game(board=Board(width=30, height=20, paddle_width=5, rows=3, columns=6))
    game.ball.y = 1.1
    game.ball.dy = -1.0
    game.ball.dx = 0.0
    game.step(1.0)
    assert game.ball.dy > 0
    assert game.state == STATE_PLAYING


# ---------------------------------------------------------- paddle bounces --


def test_paddle_bounce_reverses_vertical_direction():
    game = Game(board=Board(width=30, height=20, paddle_width=5, rows=3, columns=6))
    aim_ball_at_paddle(game)
    before = game.score
    game.step(1.0)
    assert game.ball.dy < 0
    assert game.ball.y <= game.board.paddle_row - 0.5 + 1e-9
    # A paddle hit never scores.
    assert game.score == before


def test_paddle_bounce_ang_s_according_to_where_it_hit():
    game = Game(board=Board(width=30, height=20, paddle_width=5, rows=3, columns=6))
    # Hit the left edge of the paddle: the ball must deflect to the left.
    game.paddle_x = 10
    game.ball.x = game.board.play_left + 10 + 0.2
    game.ball.y = game.board.paddle_row - 0.5
    game.ball.dx = 0.0
    game.ball.dy = 1.0
    game.step(1.0)
    assert game.ball.dx < 0
    assert game.ball.dy < 0

    # Hit the right edge: deflect to the right.
    game.ball.x = game.board.play_left + 10 + 4.8
    game.ball.y = game.board.paddle_row - 0.5
    game.ball.dx = 0.0
    game.ball.dy = 1.0
    game.step(1.0)
    assert game.ball.dx > 0
    assert game.ball.dy < 0


def test_missing_the_paddle_costs_a_life_and_reserves():
    game = Game(board=Board(width=30, height=20, paddle_width=5, rows=3, columns=6))
    game.paddle_x = 0
    game.ball.x = game.board.play_right - 1.0
    game.ball.y = game.board.paddle_row - 0.5
    game.ball.dx = 0.0
    game.ball.dy = 1.0
    score_before, lives_before = game.score, game.lives
    game.step(1.0)

    assert game.lives == lives_before - 1
    assert game.lives_remaining == game.lives
    assert game.score == score_before
    assert game.state == STATE_PLAYING
    # The ball is reset for the next serve above the paddle.
    assert game.ball.y < game.board.paddle_row
    assert game.ball.dy < 0
    # The bricks are untouched by a lost ball.
    assert game.bricks_left == 18


def test_last_ball_causes_game_over_instead_of_a_reserve():
    game = Game(board=Board(width=30, height=20, paddle_width=5, rows=3, columns=6))
    game.lives = 1
    game.paddle_x = 0
    game.ball.x = game.board.play_right - 1.0
    game.ball.y = game.board.paddle_row - 0.5
    game.ball.dx = 0.0
    game.ball.dy = 1.0
    game.step(1.0)
    assert game.lives == 0
    assert game.state == STATE_GAME_OVER
    # A dead game no longer moves the ball.
    y = game.ball.y
    game.step(1.0)
    assert game.ball.y == y


# ------------------------------------------------- bricks, scoring, and win --


def test_brick_hit_scores_and_disappears():
    game = Game(board=Board(width=30, height=20, paddle_width=5, rows=3, columns=6))
    row, col = game.board.brick_top_row + 1, 2
    brick = game.bricks[row][col]
    assert brick.alive
    game.ball.x = game.board.play_left + game.board.brick_cell_width * col + 1.0
    game.ball.y = game.board.brick_top_row + game.board.brick_cell_height + 0.5
    game.ball.dx = 0.0
    game.ball.dy = -1.0
    score_before = game.score
    game.step(1.0)

    assert game.bricks[row][col].alive is False
    assert game.bricks_left == 17
    assert game.bricks_destroyed == 1
    assert game.score == score_before + brick.points
    assert game.ball.dy > 0  # bounced downwards off the brick


def test_brick_rows_are_worth_more_towards_the_top():
    game = Game(board=Board(width=30, height=20, paddle_width=5, rows=3, columns=6))
    top = game.board.brick_top_row
    points = [game.bricks[row][0].points for row in range(top, top + 3)]
    assert points == sorted(points, reverse=True)


def test_clearing_every_brick_wins():
    game = Game(board=Board(width=30, height=20, paddle_width=5, rows=2, columns=4))
    for (row, col), brick in game.iter_bricks():
        if brick.alive:
            brick.alive = False
            game.bricks_left -= 1
            game.score += brick.points
    assert game.bricks_left == 0
    assert game.state == STATE_WIN
    # The winning ball freezes instead of costing a life.
    y = game.ball.y
    game.step(1.0)
    assert game.ball.y == y
    assert game.lives == 3


def iter_rows_and_cols(game):
    return [(row, col) for (row, col), _ in game.iter_bricks()]


# -------------------------------------------------------------- restarts ----


def test_restart_after_game_over_rebuilds_the_board():
    game = Game(board=Board(width=30, height=20, paddle_width=5, rows=3, columns=6))
    game.state = STATE_GAME_OVER
    game.lives = 0
    game.score = 1234
    game.move_paddle(1)
    game.restart()
    assert game.state == STATE_PLAYING
    assert game.score == 0
    assert game.lives == game.lives_remaining == 3
    assert game.bricks_left == 18
    assert all(b.alive for (_, _), b in game.iter_bricks())


def test_restart_after_a_win_is_equally_fresh():
    game = Game(board=Board(width=30, height=20, paddle_width=5, rows=2, columns=4))
    for (row, col), brick in game.iter_bricks():
        brick.alive = False
    game.bricks_left = 0
    game.score = 99
    assert game.state == STATE_WIN
    game.restart()
    assert game.state == STATE_PLAYING
    assert game.score == 0
    assert game.bricks_left == 8


def restart_is_a_no_op_during_play():
    game = Game(board=Board(width=30, height=20, paddle_width=5, rows=2, columns=4))
    game.score = 7
    game.restart()
    assert game.score == 7


# -------------------------------------------------- full-frame integration --


def test_repeated_steps_survive_and_keep_the_ball_in_bounds():
    game = Game(board=Board(width=30, height=20, paddle_width=5, rows=3, columns=6))
    board = game.board
    for _ in range(500):
        if game.state != STATE_PLAYING:
            break
        game.step(1.0)
        assert 1 <= game.ball.x <= board.width - 1
        assert 1 <= game.ball.y <= board.height - 1
    else:
        raise AssertionError("expected the simulation to end in a decided state")
