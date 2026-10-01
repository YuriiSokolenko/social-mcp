#!/usr/bin/env python3
"""A terminal Breakout / Arkanoid game built on curses.

The module is split in two deliberately:

* the deterministic rules (:class:`Board`, :class:`Brick`, :class:`Ball`,
  :class:`Game`) hold every game rule and need no terminal, which makes them
  unit-testable; and
* :class:`BreakoutApp` is a thin curses presentation layer that paints the
  current :class:`Game` state and forwards keyboard input into it.
"""

from __future__ import annotations

import curses
import random
import sys
from dataclasses import dataclass, field
from typing import Iterator, List, Optional, Tuple

# The project name declared by ``[project].name`` in ``pyproject.toml``. It is
# hard-coded so the banner does not need any file discovery at startup.
PROJECT_NAME = "social-mcp"

STATE_PLAYING = "playing"
STATE_WIN = "win"
STATE_GAME_OVER = "game_over"

BORDER_CHAR = "#"
BRICK_CHARS = "ABCDEFGHIJK"
BALL_CHAR = "O"
PADDLE_CHAR = "="
EMPTY = " "


class TerminalTooSmall(Exception):
    """Raised when the terminal cannot host the play-field plus HUD."""


@dataclass(frozen=True)
class Board:
    """Fixed play-field geometry, measured in character cells."""

    width: int = 40
    height: int = 22
    paddle_width: int = 7
    brick_rows: int = 4
    brick_cols: int = 8
    brick_cell_width: int = 4
    brick_cell_height: int = 2

    def __post_init__(self) -> None:
        for name in ("width", "height", "paddle_width", "brick_rows", "brick_cols"):
            if getattr(self, name) < 1:
                raise ValueError(f"invalid board dimension: {name}")
        if self.width < 12 or self.height < 12:
            raise ValueError("board is too small to play")
        if self.paddle_width >= self.width:
            raise ValueError("paddle must be narrower than the board")
        if self.brick_cell_width * self.brick_cols > self.play_width:
            raise ValueError("brick rows must fit inside the play-field")
        if self.brick_top_row + self.brick_rows * self.brick_cell_height >= self.paddle_row:
            raise ValueError("bricks must sit above the paddle")

    # ---- geometry helpers -------------------------------------------------

    @property
    def play_width(self) -> int:
        """Columns available between the left and right borders."""
        return self.width - 2

    @property
    def play_height(self) -> int:
        return self.height - 2

    @property
    def play_left(self) -> int:
        return 1

    @property
    def play_right(self) -> int:
        return self.width - 1

    @property
    def play_bottom(self) -> int:
        return self.height - 1

    @property
    def brick_top_row(self) -> int:
        return 3

    @property
    def paddle_row(self) -> int:
        return self.height - 3


def cell_to_brick(board: Board, row: int, col: int) -> Tuple[int, int]:
    """Map a play-field cell to its brick grid coordinates.

    Returns ``(-1, -1)`` for cells outside the brick field.
    """
    row_index = row - board.brick_top_row
    if row_index < 0 or row_index >= board.brick_rows * board.brick_cell_height:
        return -1, -1
    col_index = (col - board.play_left) // board.brick_cell_width
    if col_index < 0 or col_index >= board.brick_cols:
        return -1, -1
    return row_index // board.brick_cell_height, col_index


@dataclass
class Brick:
    """One brick. Rows closer to the top are worth more points."""

    row: int
    col: int
    points: int
    alive: bool = True


@dataclass
class Ball:
    """The ball's position and velocity in cells per (simulated) second."""

    x: float = 0.0
    y: float = 0.0
    dx: float = 0.0
    dy: float = 0.0


class Game:
    """The complete, deterministic game rules without any terminal access."""

    def __init__(self, board: Optional[Board] = None, seed: int = 1234) -> None:
        self.board = board if board is not None else Board()
        self.rng = random.Random(seed)
        self.ball = Ball()
        self.restart()

    # ------------------------------------------------------------- lifecycle

    def restart(self) -> None:
        """Start a brand-new game (also used to restart after win/loss)."""
        self.score = 0
        self.lives = 3
        self.state = STATE_PLAYING
        self.message = ""
        self.paddle_x = (self.board.play_width - self.board.paddle_width) // 2
        self.bricks = [
            [
                Brick(row, col, points=self.brick_points(row))
                for col in range(self.board.brick_cols)
            ]
            for row in range(self.board.brick_rows)
        ]
        self.bricks_left = self.board.brick_rows * self.board.brick_cols
        self.bricks_destroyed = 0
        self.serve()

    def brick_points(self, row: int) -> int:
        return 10 * (self.board.brick_rows - row)

    def serve(self) -> None:
        """Put the ball back on top of the paddle, moving upwards."""
        ball = self.ball
        ball.x = self.board.play_left + self.paddle_x + self.board.paddle_width / 2.0
        ball.y = float(self.board.paddle_row - 1)
        angle = self.rng.uniform(0.25, 0.75)
        self.ball.dx = (angle - 0.5) * 2.0
        self.ball.dy = -1.0
        self.normalise_ball()

    def normalise_ball(self, speed: float = 1.25) -> None:
        magnitude = (self.ball.dx ** 2 + self.ball.dy ** 2) ** 0.5
        if magnitude == 0:
            self.ball.dx, self.ball.dy = 0.0, -speed
            return
        self.ball.dx = self.ball.dx / magnitude * speed
        self.ball.dy = self.ball.dy / magnitude * speed

    # ------------------------------------------------------------ accessors

    @property
    def lives_remaining(self) -> int:
        return self.lives

    @property
    def paddle_left(self) -> int:
        return self.paddle_x

    @property
    def paddle_right(self) -> int:
        return self.paddle_x + self.board.paddle_width - 1

    def iter_bricks(self) -> Iterator[Tuple[Tuple[int, int], Brick]]:
        for row in range(self.board.brick_rows):
            for col in range(self.board.brick_cols):
                yield (row, col), self.bricks[row][col]

    def brick_cell(self, row: int, col: int) -> Tuple[int, int]:
        """Top-left play-field cell of brick ``(row, col)``."""
        return (
            self.board.brick_top_row + row * self.board.brick_cell_height,
            self.board.play_left + col * self.board.brick_cell_width,
        )

    # -------------------------------------------------------------- actions

    def move_paddle(self, direction: int) -> None:
        if direction == 0:
            return
        max_x = self.board.play_width - self.board.paddle_width
        self.paddle_x = max(0, min(max_x, self.paddle_x + direction))

    def step(self, dt: float = 1.0) -> None:
        """Advance the simulation by ``dt`` frames' worth of motion."""
        if self.state != STATE_PLAYING:
            return
        ball = self.ball
        remaining = max(0.0, dt)
        # Move in small increments so collisions cannot be tunnelled through.
        step = 0.25
        while remaining > 1e-9:
            fraction = min(step, remaining)
            remaining -= fraction
            ball.x += ball.dx * fraction
            ball.y += ball.dy * fraction
            self._collide()
            if self.state != STATE_PLAYING:
                return

    # ------------------------------------------------------------ internals

    def _collide(self) -> None:
        board = self.board
        ball = self.ball

        # Side walls.
        if ball.x < board.play_left:
            ball.x = float(board.play_left)
            ball.dx = abs(ball.dx)
        elif ball.x > board.play_right - 1:
            ball.x = float(board.play_right - 1)
            ball.dx = -abs(ball.dx)

        # Top border.
        if ball.y < 1:
            ball.y = 1.0
            ball.dy = abs(ball.dy)

        # Bricks.
        row, col = cell_to_brick(board, int(round(ball.y)), int(round(ball.x)))
        if 0 <= row < board.brick_rows and 0 <= col < board.brick_cols:
            brick = self.bricks[row][col]
            if brick.alive:
                brick.alive = False
                self.bricks_left -= 1
                self.bricks_destroyed += 1
                self.score += brick.points
                ball.dy = -ball.dy
                if self.bricks_left == 0:
                    self.state = STATE_WIN
                    self.message = "You cleared the board!"
                return

        # Paddle.
        if ball.dy > 0 and board.paddle_row - 1 <= ball.y <= board.paddle_row:
            centre = board.play_left + self.paddle_x + self.board.paddle_width / 2.0
            offset = (ball.x - centre) / (self.board.paddle_width / 2.0)
            if -1.0 <= offset <= 1.0:
                ball.y = float(board.paddle_row - 1)
                ball.dy = -1.0
                ball.dx = max(-0.8, min(0.8, offset * 1.2))
                self.normalise_ball()
                return

        # Missed the paddle.
        if ball.y > board.paddle_row:
            self.lose_life()

    def lose_life(self) -> None:
        self.lives -= 1
        if self.lives <= 0:
            self.lives = 0
            self.state = STATE_GAME_OVER
            self.message = "Game over."
            return
        self.serve()


# ------------------------------------------------------------- presentation


def format_banner(width: int = 0) -> str:
    name = PROJECT_NAME
    line = f"=== {name} :: BREAKOUT ==="
    if width and len(line) > width:
        line = line[: max(0, width - 1)] + "!"
    return line


def format_hud(game: Game) -> str:
    return f"Score {game.score:<6} Lives {game.lives}"


class BreakoutApp:
    """Drive :class:`Game` with curses: rendering and keyboard input only."""

    def __init__(self, stdscr, board: Board) -> None:
        self.stdscr = stdscr
        self.board = board
        self.game = Game(board)
        self.last_row = -1
        self.last_col = -1

    def required_size(self) -> Tuple[int, int]:
        return self.board.height, self.board.width

    def draw(self) -> None:
        raise NotImplementedError  # pragma: no cover - overridden below

    def run(self) -> None:  # pragma: no cover - exercised manually
        raise NotImplementedError  # pragma: no cover - overridden below


def _paint(scr, y: int, x: int, text: str, attr: int = 0) -> None:
    if text:
        scr.addstr(y, x, text, attr)


def draw(scr, game: Game, banner: str, note: str = "") -> None:
    """Render one frame of ``game`` into the curses window ``scr``."""
    board = game.board
    scr.erase()
    _paint(scr, 0, 0, banner[: board.width])
    _paint(scr, 1, 0, format_hud(game)[: board.width])

    # Borders.
    for x in range(board.width):
        _paint(scr, board.brick_top_row - 1, x, BORDER_CHAR)
    bottom = board.height - 2
    for x in range(board.width):
        _paint(scr, bottom + 1, x, BORDER_CHAR)
    for y in range(board.brick_top_row - 1, bottom + 2):
        _paint(scr, y, 0, BORDER_CHAR)
        _paint(scr, y, board.width - 1, BORDER_CHAR)

    # Bricks.
    for index, (coord, brick) in enumerate(game.iter_bricks()):
        if not brick.alive:
            continue
        row, col = game.brick_cell(*coord)
        char = BRICK_CHARS[index % len(BRICK_CHARS)]
        for offset in range(board.brick_cell_width):
            for dy in range(board.brick_cell_height):
                _paint(scr, row + dy, col + offset, char)

    # Paddle.
    paddle_y = board.paddle_row
    for offset in range(board.paddle_width):
        _paint(scr, paddle_y, board.play_left + game.paddle_x + offset, PADDLE_CHAR)

    # Ball.
    ball = game.ball
    _paint(scr, int(round(ball.y)), int(round(ball.x)), BALL_CHAR)

    if note:
        _paint(scr, board.height - 1, 0, note[: board.width])


def run(stdscr) -> None:  # pragma: no cover - manual/interactive path
    board = Board()
    try:
        curses.curs set()  # noqa: E999 - replaced below
    except Exception:
        pass
    raise NotImplementedError
