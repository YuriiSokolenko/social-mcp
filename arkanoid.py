#!/usr/bin/env python3
"""
arkanoid.py -- A classic Arkanoid (Breakout) game running in a terminal.

Drawn entirely with text characters using the standard-library ``curses``
module.  Controls:

  Arrow keys / 'a' 'd' / 'h' 'l'  -- move paddle left / right
  <Space>                          -- serve / restart
  <Esc> / 'q'                      -- quit

The game is fully self-contained and has no external dependencies.
"""

import curses
import random
import sys
import time

# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------

MIN_HEIGHT = 24       # minimum terminal height for the game
MIN_WIDTH = 80        # minimum terminal width
FIELD_TOP = 3         # banner rows at the top
FIELD_BOTTOM = 1      # rows reserved at the bottom
BRICK_ROWS = 6
BRICK_HEIGHT = 1
BRICK_PADDING_X = 1
PADDLE_WIDTH = 9
PADDLE_CHAR = "="
BALL_CHAR = "O"
BALL_SPEED = 2.8
BORDER_V = "|"
BORDER_H = "-"
BORDER_C = "+"
TICK_MS = 30          # milliseconds per game tick
STARTING_LIVES = 3
BRICK_POINTS = 10


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def clamp(value, low, high):
    """Restrict *value* to the inclusive range [low, high]."""
    return max(low, min(high, value))


def line_points(x0, y0, x1, y1):
    """Yield all integer cells on the Bresenham line from (x0,y0) to (x1,y1).

    This prevents fast-moving balls from "tunneling" through bricks.
    """
    x0 = int(round(x0)); y0 = int(round(y0))
    x1 = int(round(x1)); y1 = int(round(y1))
    dx = abs(x1 - x0); dy = -abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx + dy
    while True:
        yield x0, y0
        if x0 == x1 and y0 == y1:
            break
        e2 = 2 * err
        if e2 >= dy:
            err += dy; x0 += sx
        if e2 <= dx:
            err += dx; y0 += sy


# ---------------------------------------------------------------------------
# Game entities
# ---------------------------------------------------------------------------

class Paddle:
    """The player-controlled paddle at the bottom of the field."""

    def __init__(self, field_left, field_right, row):
        self.width = PADDLE_WIDTH
        self.field_left = field_left
        self.field_right = field_right
        self.x = (field_left + field_right) // 2 - self.width // 2
        self.row = row

    @property
    def left(self):
        return int(self.x)

    @property
    def right(self):
        return int(self.x) + self.width - 1

    def move(self, delta):
        self.x = clamp(self.x + delta, self.field_left,
                       self.field_right - self.width + 1)

    def draw(self, win):
        for i in range(self.width):
            try:
                win.addch(self.row, int(self.x) + i, PADDLE_CHAR)
            except curses.error:
                pass


class Ball:
    """The bouncing ball.  Position is stored as floats for sub-pixel motion."""

    def __init__(self, col, row):
        self.col = float(col)
        self.row = float(row)
        self.dx = 0.0
        self.dy = 0.0

    @property
    def x(self):
        return int(round(self.col))

    @property
    def y(self):
        return int(round(self.row))

    def serve(self, speed=BALL_SPEED):
        """Give the ball a serve velocity toward the top of the field."""
        angle = random.uniform(-0.5, 0.5)
        self.dx = speed * angle
        if abs(self.dx) < 0.5:
            self.dx = 0.5 if random.random() < 0.5 else -0.5
        self.dy = -speed

    def update(self):
        self.col += self.dx
        self.row += self.dy

    def draw(self, win):
        try:
            win.addch(self.y, self.x, BALL_CHAR)
        except curses.error:
            pass


class Brick:
    """A single destructible brick occupying one cell."""

    def __init__(self, col, row, points=BRICK_POINTS):
        self.col = col
        self.row = row
        self.points = points

    def draw(self, win):
        try:
            win.addch(self.row, self.col, "#")
        except curses.error:
            pass


# ---------------------------------------------------------------------------
# Game
# ---------------------------------------------------------------------------

class Game:
    """Encapsulates all game state and the main interaction loop."""

    def __init__(self, stdscr):
        self.stdscr = stdscr
        self.height, self.width = stdscr.getmaxyx()

        # Play-field boundaries (inside the border).
        self.field_left = 2
        self.field_right = self.width - 3
        self.field_top = FIELD_TOP
        self.field_bottom = self.height - 2

        # State objects.
        self.paddle = None
        self.ball = None
        self.bricks = []
        self.score = 0
        self.lives = STARTING_LIVES
        self.ball_served = False
        self.running = True
        self.game_over = False
        self.won = False
        self.message = ""

        # Terminal setup -- cbreak gives us character-at-a-time input,
        # noecho prevents characters from being echoed to the screen.
        curses.curs_set(0)
        curses.cbreak()
        curses.noecho()
        # timeout makes getch() block for at most TICK_MS ms, enabling
        # both input reading and a fixed game tick rate.
        self.stdscr.timeout(TICK_MS)

        self.new_game()

    # -- Setup --

    def build_bricks(self):
        """Create a grid of bricks spanning the full field width."""
        self.bricks = []
        field_width = self.field_right - self.field_left + 1
        cols = field_width - 2 * BRICK_PADDING_X
        start_col = self.field_left + BRICK_PADDING_X
        rows = min(BRICK_ROWS, self.field_bottom - self.field_top - 2)
        for row_idx in range(rows):
            row = self.field_top + row_idx * BRICK_HEIGHT
            for col_idx in range(cols):
                self.bricks.append(Brick(start_col + col_idx, row))

    def new_game(self):
        """Reset everything for a fresh game."""
        self.paddle = Paddle(self.field_left, self.field_right,
                             self.field_bottom - 2)
        self.ball = Ball(self.paddle.left + self.paddle.width // 2,
                         self.paddle.row - 1)
        self.build_bricks()
        self.score = 0
        self.lives = STARTING_LIVES
        self.ball_served = False
        self.game_over = False
        self.won = False
        self.message = "Arrow keys / a-d to move, space to serve, q to quit"

    def reset_ball(self):
        """Place the ball on the paddle for the next serve."""
        self.ball.col = float(self.paddle.left + self.paddle.width // 2)
        self.ball.row = float(self.paddle.row - 1)
        self.ball.dx = 0.0
        self.ball.dy = 0.0
        self.ball_served = False

    # -- Input --

    def handle_input(self):
        """Process all pending keyboard input.

        Arrow keys are handled manually (without keypad(True)) because
        keypad(True) can cause getch() to block while waiting for a
        complete escape sequence, even with timeout() set.
        """
        while True:
            try:
                ch = self.stdscr.getch()
            except curses.error:
                break
            if ch == -1:
                break

            if ch == 27:
                # ESC -- could be standalone (quit) or start of an
                # arrow-key escape sequence (ESC [ C / D).
                seq = self._read_bytes(2)
                if len(seq) >= 2 and seq[0] == ord('[') and seq[1] == ord('C'):
                    self.paddle.move(2)       # right arrow
                    continue
                if len(seq) >= 2 and seq[0] == ord('[') and seq[1] == ord('D'):
                    self.paddle.move(-2)      # left arrow
                    continue
                self.running = False          # standalone ESC = quit
                break

            if ch in (ord('q'), ord('Q')):
                self.running = False
                break
            elif ch in (ord('a'), ord('A'), ord('h'), ord('H')):
                self.paddle.move(-2)
            elif ch in (ord('d'), ord('D'), ord('l'), ord('L')):
                self.paddle.move(2)
            elif ch in (ord(' '), ord('\n'), ord('\r')):
                if not self.ball_served and not self.game_over:
                    self.ball_served = True
                    self.ball.serve()
                elif self.game_over or self.won:
                    self.new_game()

    def _read_bytes(self, count):
        """Read up to *count* bytes.  Returns a list of ints."""
        result = []
        for _ in range(count):
            try:
                b = self.stdscr.getch()
            except curses.error:
                break
            if b == -1:
                break
            result.append(b)
        return result

    # -- Physics / collision --

    def _find_brick(self, col, row):
        """Return the brick at (col, row) or None."""
        for brick in self.bricks:
            if brick.col == col and brick.row == row:
                return brick
        return None

    def update(self):
        if self.game_over or self.won or not self.ball_served:
            return

        # Remember where we were so we can check the full path the
        # ball travels (prevents tunnelling through bricks).
        old_x = self.ball.col
        old_y = self.ball.row
        self.ball.update()

        # --- Walls ---
        if self.ball.col <= self.field_left:
            self.ball.col = float(self.field_left)
            self.ball.dx = abs(self.ball.dx)
        if self.ball.col >= self.field_right:
            self.ball.col = float(self.field_right)
            self.ball.dx = -abs(self.ball.dx)
        if self.ball.row <= self.field_top:
            self.ball.row = float(self.field_top)
            self.ball.dy = abs(self.ball.dy)

        # --- Bottom: lose a life ---
        if self.ball.row >= self.field_bottom:
            self.lives -= 1
            if self.lives <= 0:
                self.game_over = True
                self.message = "GAME OVER -- press space to restart, q to quit"
            else:
                self.message = "Lost a life -- press space to serve"
            self.reset_ball()
            return

        # --- Brick collision (check full path) ---
        hit_brick = None
        hit_x = hit_y = None
        for cx, cy in line_points(old_x, old_y, self.ball.col, self.ball.row):
            brick = self._find_brick(cx, cy)
            if brick is not None:
                hit_brick = brick
                hit_x = cx
                hit_y = cy
                break

        if hit_brick is not None:
            self.bricks.remove(hit_brick)
            self.score += hit_brick.points
            self.message = f"Hit a brick! +{hit_brick.points} points"

            # Determine bounce direction from the ball's approach.
            prev_y = int(round(old_y))
            prev_x = int(round(old_x))
            new_y = int(round(self.ball.row))
            new_x = int(round(self.ball.col))
            if prev_y != new_y and prev_x != new_x:
                self.ball.dy = -self.ball.dy
                self.ball.dx = -self.ball.dx
            elif prev_y != new_y:
                self.ball.dy = -self.ball.dy
            elif prev_x != new_x:
                self.ball.dx = -self.ball.dx
            else:
                self.ball.dy = -self.ball.dy

            # Nudge ball out of the brick to prevent sticking.
            self.ball.col = float(hit_x) + self.ball.dx
            self.ball.row = float(hit_y) + self.ball.dy

            if not self.bricks:
                self.won = True
                self.message = "YOU WIN! All bricks destroyed. Space = restart"
            return

        # --- Paddle collision ---
        ball_y = int(round(self.ball.row))
        ball_x = int(round(self.ball.col))
        paddle_row = self.paddle.row
        if (self.ball.dy > 0 and
                ball_y >= paddle_row and
                self.paddle.left <= ball_x <= self.paddle.right):
            if self.ball.row <= paddle_row:
                self.ball.row = float(paddle_row - 1)
                self.ball.dy = -abs(self.ball.dy)
                # Sideways kick based on where the ball hit the paddle.
                offset = (ball_x - self.paddle.left) - self.paddle.width / 2.0
                self.ball.dx += offset * 0.25
                self.ball.dx = clamp(self.ball.dx, -3.5, 3.5)
                if abs(self.ball.dx) < 0.3:
                    self.ball.dx = 0.3 if self.ball.dx >= 0 else -0.3

    # -- Rendering --

    def draw_border(self):
        top = self.field_top - 1
        bottom = min(self.field_bottom + 1, self.height - 1)
        left = self.field_left - 1
        right = min(self.field_right + 1, self.width - 1)
        try:
            for col in range(left, right + 1):
                self.stdscr.addch(top, col, BORDER_H)
                if top < bottom:
                    self.stdscr.addch(bottom, col, BORDER_H)
            for row in range(top, bottom + 1):
                self.stdscr.addch(row, left, BORDER_V)
                if left < right:
                    self.stdscr.addch(row, right, BORDER_V)
            self.stdscr.addch(top, left, BORDER_C)
            self.stdscr.addch(top, right, BORDER_C)
            self.stdscr.addch(bottom, left, BORDER_C)
            self.stdscr.addch(bottom, right, BORDER_C)
        except curses.error:
            pass

    def draw_banner(self):
        line = f" SCORE: {self.score:>5}  LIVES: {self.lives}  ARKANOID "
        line = line[:self.width - 1]
        try:
            self.stdscr.addstr(0, 0, line, curses.A_BOLD)
        except curses.error:
            pass

    def draw_status(self):
        text = self.message[:self.width - 1]
        try:
            self.stdscr.addstr(self.height - 1, 0, text, curses.A_REVERSE)
        except curses.error:
            pass

    def draw_centered(self, text):
        text = text[:self.width - 1]
        start_col = (self.width - len(text)) // 2
        row = max(self.field_top,
                  min(self.field_bottom,
                      (self.field_top + self.field_bottom) // 2))
        try:
            self.stdscr.addstr(row, start_col, text, curses.A_BOLD)
        except curses.error:
            pass

    def render(self):
        self.stdscr.clear()  # clear() forces full redraw on refresh

        if self.height < MIN_HEIGHT or self.width < MIN_WIDTH:
            self.draw_banner()
            try:
                self.stdscr.addstr(1, 0, "Terminal too small for Arkanoid.",
                                   curses.A_BOLD)
                self.stdscr.addstr(2, 0,
                    f"Need at least {MIN_WIDTH}x{MIN_HEIGHT} (have "
                    f"{self.width}x{self.height}). Resize and restart.",
                    curses.A_REVERSE)
            except curses.error:
                pass
            self.stdscr.refresh()
            return

        self.draw_banner()
        self.draw_border()
        self.paddle.draw(self.stdscr)
        self.ball.draw(self.stdscr)
        for brick in self.bricks:
            brick.draw(self.stdscr)
        self.draw_status()

        if self.game_over:
            self.draw_centered("  G  A  M  E   O  V  E  R  ")
        elif self.won:
            self.draw_centered("  Y  O  U   W  I  N  !  ")

        self.stdscr.refresh()

    # -- Main loop --

    def run(self):
        while self.running:
            self.render()
            self.handle_input()
            if self.height < MIN_HEIGHT or self.width < MIN_WIDTH:
                time.sleep(0.1)
                continue
            self.update()
        return self.running


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(stdscr):
    """ curses wrapper callback. """
    game = Game(stdscr)
    game.run()


if __name__ == "__main__":
    try:
        curses.wrapper(main)
    except KeyboardInterrupt:
        pass
    sys.exit(0)
