#!/usr/bin/env python3
"""Breakout / Arkanoid clone.

A complete, playable terminal Breakout game implemented with the Python
standard library only (``curses`` for the terminal UI).

The game logic (state, movement, collisions, scoring, lives, win/game-over and
restart transitions) lives in :class:`Breakout` and is fully deterministic and
terminal-free so it can be unit-tested. The curses rendering and keyboard input
is kept in :func:`run` / :func:`_curses_main`, separate from that logic.
"""

from __future__ import annotations

import curses
import dataclasses
import sys

# The banner/project-name constant is the exact value declared under
# ``[project].name`` in pyproject.toml and is hard-coded here per the issue.
PROJECT_NAME = "social-mcp"

# --- Layout constants -------------------------------------------------------

DEFAULT_HEIGHT = 24
DEFAULT_WIDTH = 80
TOP_BORDER = 1
BOTTOM_BORDER = DEFAULT_HEIGHT - 2
LEFT_BORDER = 1
RIGHT_BORDER = DEFAULT_WIDTH - 2

PADDLE_WIDTH = 9
PADDLE_HEIGHT = 1
PADDLE_ROW = BOTTOM_BORDER - 1

BALL_CHAR = "O"
PADDLE_CHAR = "="
BRICK_CHAR = "+"

# Point values per brick type. A brick with ``hits`` HP is worth
# ``hits * 10`` points, capped at the table below.
BRICK_POINTS = {
    1: 40,
    2: 30,
    3: 20,
    4: 10,
}

MAX_LIVES = 3

MIN_TERMINAL_HEIGHT = 12
MIN_TERMINAL_WIDTH = 40


def _brick_points(hits: int) -> int:
    """Return the score a brick with ``hits`` hit-points is worth."""
    return BRICK_POINTS.get(hits, 10)


@dataclasses.dataclass
class Point:
    """A simple integer coordinate."""

    x: int
    y: int


@dataclasses.dataclass
class Ball:
    """The ball: position, velocity and active flag."""

    pos: Point = dataclasses.field(default_factory=lambda: Point(0, 0))
    vel_x: int = 0
    vel_y: int = 0

    @property
    def active(self) -> bool:
        return self.vel_x != 0 or self.vel_y != 0


@dataclasses.dataclass
class Paddle:
    """The player paddle: left edge column and width."""

    left: int = 0
    width: int = PADDLE_WIDTH

    def top(self) -> int:
        """Return the row the paddle occupies."""
        return PADDLE_ROW

    def right(self) -> int:
        return self.left + self.width - 1


@dataclasses.dataclass
class Brick:
    """A single brick: position, width, hit-points and whether it is alive."""

    x: int
    y: int
    width: int
    hits: int
    alive: bool = True


class Breakout:
    """Deterministic Breakout game state and rules.

    This class contains no terminal / curses code. Every method is pure with
    respect to rendering and can be exercised by unit tests.
    """

    def __init__(
        self,
        width: int = DEFAULT_WIDTH,
        height: int = DEFAULT_HEIGHT,
        rows: int = 6,
        cols: int = 10,
    ) -> None:
        self.width = width
        self.height = height
        self.rows = rows
        self.cols = cols

        self.paddle = Paddle()
        self.ball = Ball()
        self.bricks: list[Brick] = []
        self.score = 0
        self.lives = MAX_LIVES
        self.game_over = False
        self.won = False

        self._init_bricks()
        self.center_paddle()
        self.reset_ball()

    # ------------------------------------------------------------------ #
    # Setup helpers
    # ------------------------------------------------------------------ #

    def _init_bricks(self) -> None:
        """Build a full grid of bricks in the top portion of the arena."""
        brick_width = 6
        start_y = TOP_BORDER + 1
        for r in range(self.rows):
            # Each row gets progressively weaker (more hits => lower points).
            hits = self.rows - r
            for c in range(self.cols):
                x = LEFT_BORDER + 1 + c * (brick_width + 1)
                # Stop if bricks would run past the right border.
                if x + brick_width > RIGHT_BORDER:
                    break
                self.bricks.append(
                    Brick(x=x, y=start_y + r, width=brick_width, hits=hits)
                )

    def center_paddle(self) -> None:
        """Center the paddle horizontally."""
        self.paddle.left = (self.width - self.paddle.width) // 2

    def reset_ball(self) -> None:
        """Place the ball on the paddle ready for the next serve."""
        self.ball.pos = Point(
            self.paddle.left + self.paddle.width // 2, self.paddle.top()
        )
        self.ball.vel_x = 0
        self.ball.vel_y = 0

    def serve(self) -> None:
        """Launch the ball for the next serve."""
        self.ball.pos = Point(
            self.paddle.left + self.paddle.width // 2, self.paddle.top()
        )
        self.ball.vel_x = -1
        self.ball.vel_y = -1

    # ------------------------------------------------------------------ #
    # Paddle
    # ------------------------------------------------------------------ #

    def paddle_left(self) -> int:
        return self.paddle.left

    def paddle_right(self) -> int:
        return self.paddle.right()

    def move_paddle(self, dx: int) -> None:
        """Move the paddle by ``dx`` columns, clamped to the arena bounds."""
        if self.game_over or self.won:
            return
        new_left = self.paddle.left + dx
        min_left = LEFT_BORDER
        max_left = RIGHT_BORDER - self.paddle.width
        if new_left < min_left:
            new_left = min_left
        if new_left > max_left:
            new_left = max_left
        self.paddle.left = new_left

    # ------------------------------------------------------------------ #
    # Ball movement & collision
    # ------------------------------------------------------------------ #

    def update(self) -> None:
        """Advance the game by one tick.

        Handles serving, ball movement, wall/border bounces, paddle and brick
        collision, life loss, win and game-over transitions.
        """
        if self.game_over or self.won:
            return

        # If the ball is not moving (waiting to be served), serve it.
        if not self.ball.active:
            self.serve()
            return

        # Move the ball.
        self.ball.pos.x += self.ball.vel_x
        self.ball.pos.y += self.ball.vel_y

        # Wall bounces (left/right borders).
        if self.ball.pos.x <= LEFT_BORDER:
            self.ball.pos.x = LEFT_BORDER
            self.ball.vel_x = -self.ball.vel_x
            if self.ball.vel_x == 0:
                self.ball.vel_x = 1
        elif self.ball.pos.x >= RIGHT_BORDER:
            self.ball.pos.x = RIGHT_BORDER
            self.ball.vel_x = -self.ball.vel_x
            if self.ball.vel_x == 0:
                self.ball.vel_x = -1

        # Top border bounce.
        if self.ball.pos.y <= TOP_BORDER:
            self.ball.pos.y = TOP_BORDER
            self.ball.vel_y = -self.ball.vel_y
            if self.ball.vel_y == 0:
                self.ball.vel_y = 1

        # Paddle collision.
        if self.ball.pos.y == self.paddle.top() and self.ball.vel_y > 0:
            if self.paddle_left() <= self.ball.pos.x <= self.paddle_right():
                self.ball.vel_y = -self.ball.vel_y
                if self.ball.vel_y == 0:
                    self.ball.vel_y = -1
                # Nudge back above the paddle to avoid sticking.
                self.ball.pos.y = self.paddle.top() - 1
                # Add a little horizontal deflection based on where it hit.
                center = self.paddle_left() + self.paddle.width // 2
                offset = self.ball.pos.x - center
                if offset != 0:
                    self.ball.vel_x += 1 if offset > 0 else -1
                # Clamp horizontal speed.
                self.ball.vel_x = max(-3, min(3, self.ball.vel_x))

        # Brick collision.
        self._check_brick_collision()

        # Losing the ball (below the bottom border).
        if self.ball.pos.y >= self.height - 1:
            self.lives -= 1
            if self.lives <= 0:
                self.lives = 0
                self.game_over = True
            self.reset_ball()

        # Win check.
        if all(not b.alive for b in self.bricks) and self.bricks:
            self.won = True

    def _check_brick_collision(self) -> None:
        """Detect and resolve a collision between the ball and a brick."""
        bx, by = self.ball.pos.x, self.ball.pos.y
        for brick in self.bricks:
            if not brick.alive:
                continue
            if by == brick.y and brick.x <= bx < brick.x + brick.width:
                brick.alive = False
                self.score += _brick_points(brick.hits)
                self.ball.vel_y = -self.ball.vel_y
                if self.ball.vel_y == 0:
                    self.ball.vel_y = -1
                # Nudge the ball out of the brick.
                self.ball.pos.y = brick.y - 1 if self.ball.vel_y < 0 else brick.y + 1
                break

    # ------------------------------------------------------------------ #
    # State transitions
    # ------------------------------------------------------------------ #

    def restart(self) -> None:
        """Reset the whole game to its initial state."""
        self.score = 0
        self.lives = MAX_LIVES
        self.game_over = False
        self.won = False
        self.bricks = []
        self._init_bricks()
        self.center_paddle()
        self.reset_ball()

    def is_running(self) -> bool:
        """Return True while the game is actively in play."""
        return not self.game_over and not self.won

    # ------------------------------------------------------------------ #
    # Rendering helpers (pure — return strings / layouts, no curses)
    # ------------------------------------------------------------------ #

    def render_lines(self) -> list[str]:
        """Return a list of strings representing the current frame.

        This is deterministic and terminal-free so tests can verify it. The
        returned list has ``height`` rows, each of width ``width``.
        """
        grid = [[" "] * self.width for _ in range(self.height)]

        # Top/bottom borders.
        for x in range(LEFT_BORDER, RIGHT_BORDER + 1):
            grid[TOP_BORDER][x] = "-"
            grid[BOTTOM_BORDER][x] = "-"

        # Side borders.
        for y in range(TOP_BORDER, BOTTOM_BORDER + 1):
            grid[y][LEFT_BORDER] = "|"
            grid[y][RIGHT_BORDER] = "|"

        # Bricks.
        for brick in self.bricks:
            if brick.alive:
                for x in range(brick.x, brick.x + brick.width):
                    if LEFT_BORDER < x < RIGHT_BORDER:
                        grid[brick.y][x] = BRICK_CHAR

        # Paddle.
        for x in range(self.paddle_left(), self.paddle_right() + 1):
            grid[PADDLE_ROW][x] = PADDLE_CHAR

        # Ball.
        if 0 <= self.ball.pos.x < self.width and 0 <= self.ball.pos.y < self.height:
            grid[self.ball.pos.y][self.ball.pos.x] = BALL_CHAR

        return ["".join(row) for row in grid]


def banner_lines() -> list[str]:
    """Return the title banner lines shown at the top of the game."""
    title = "  {} BREAKOUT".format(PROJECT_NAME.upper())
    edge = "-" * (len(title) + 4)
    return [edge, f"|{title}|", edge]


def run() -> None:
    """Entry point: run the game under ``curses.wrapper`` for safe teardown."""
    curses.wrapper(_curses_main)


def _curses_main(stdscr) -> None:
    """Main curses loop. Separated from logic for testability."""
    game = Breakout()
    game.center_paddle()

    # Configure curses.
    curses.curs_set(0)
    stdscr.keypad(True)
    stdscr.nodelay(True)
    stdscr.esc_delay = 0

    term_h, term_w = stdscr.getmaxyx()
    if term_h < MIN_TERMINAL_HEIGHT or term_w < MIN_TERMINAL_WIDTH:
        stdscr.clear()
        msg = (
            "Terminal too small: need at least {}x{}, got {}x{}.".format(
                MIN_TERMINAL_WIDTH, MIN_TERMINAL_HEIGHT, term_w, term_h
            )
        )
        try:
            stdscr.addstr(0, 0, msg)
        except curses.error:
            pass
        stdscr.refresh()
        # Wait for the user to acknowledge before exiting.
        stdscr.nodelay(False)
        stdscr.getch()
        return

    while True:
        game.update()
        lines = game.render_lines()

        stdscr.clear()
        # Draw the arena inside the terminal.
        for y, row in enumerate(lines):
            if y >= term_h:
                break
            try:
                stdscr.addstr(y, 0, row[:term_w])
            except curses.error:
                pass

        # Status line below the arena.
        status_y = game.height + 1
        if status_y < term_h:
            status = "Score: {}  Lives: {}  ".format(game.score, game.lives)
            if game.won:
                status += "WIN! "
            if game.game_over:
                status += "GAME OVER "
            status += "[{}]".format(PROJECT_NAME)
            try:
                stdscr.addstr(status_y, 0, status[:term_w])
            except curses.error:
                pass

        # Message for win / game over.
        if game.won or game.game_over:
            msg = "WINNER!" if game.won else "GAME OVER"
            hint = "Press [r] to restart, [q] to quit."
            try:
                stdscr.addstr(game.height // 2, game.width // 4, msg)
                stdscr.addstr(game.height // 2 + 1, game.width // 4, hint)
            except curses.error:
                pass

        stdscr.refresh()

        # Non-blocking input.
        try:
            ch = stdscr.getch()
        except curses.error:
            ch = -1

        if ch == -1:
            continue

        if ch in (ord("q"), ord("Q")):
            break

        if ch in (ord("r"), ord("R")):
            game.restart()
            continue

        if ch in (curses.KEY_LEFT, ord("a"), ord("A")):
            game.move_paddle(-2)
        elif ch in (curses.KEY_RIGHT, ord("d"), ord("D")):
            game.move_paddle(2)

        # Small delay so the ball isn't too fast.
        curses.napms(30)


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        sys.exit(0)
