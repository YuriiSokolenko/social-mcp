#!/usr/bin/env python3
"""Arkanoid / Breakout clone drawn with text characters using curses.

A self-contained, standard-library-only implementation of the classic
Arkanoid/Breakout game. Run on a compatible Ubuntu terminal:

    python3 arkanoid.py

Controls:
    Left / Right arrow  move the paddle
    q                   quit at any time
"""

import curses
import random

# Character set used for drawing the whole game.
CHAR_PADDLE = "="
CHAR_BALL = "O"
CHAR_BRICK = "#"
CHAR_WALL = "+"
CHAR_EMPTY = " "

# Initial game parameters.
START_LIVES = 3
BALL_ADVANCE_PAUSE = 0.06  # seconds between frames
MAX_BRICK_DURABILITY = 3
MIN_ROWS = 20
MIN_COLS = 40

# Game states.
STATE_PLAYING = "playing"
STATE_SERVE = "serve"
STATE_WON = "won"
STATE_GAME_OVER = "game_over"
STATE_TOO_SMALL = "too_small"


class Paddle:
    """The horizontal paddle controlled by the player."""

    def __init__(self, width):
        self.width = width
        self.reset()

    def reset(self):
        self.x = 0

    def move(self, dx, max_x):
        self.x = max(0, min(self.x + dx, max_x - self.width))

    @property
    def right(self):
        return self.x + self.width

    def center(self):
        return self.x + self.width // 2


class Ball:
    """A single ball with a position and sub-integer velocity."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.x = 0
        self.y = 0
        self.dx = 0
        self.dy = 0

    def serve(self, paddle):
        """Place the ball on the paddle ready for the next serve."""
        self.y = float(paddle.y - 1)
        self.x = float(paddle.center())
        # Serve at a random shallow upward angle.
        angle = random.choice([-2, -1, -1, 1, 1, 2])
        self.dx = float(angle)
        self.dy = -1.5

    def pos(self):
        return int(round(self.x)), int(round(self.y))


class Brick:
    """A single brick with durability (hits remaining)."""

    def __init__(self, x, y, durability, width=3):
        self.x = x
        self.y = y
        self.durability = durability
        self.width = width

    @property
    def destroyed(self):
        return self.durability <= 0

    def hit(self):
        self.durability -= 1

    def contains(self, bx, by):
        return self.y == by and self.x <= bx < self.x + self.width


class Game:
    """Top-level game state and logic."""

    def __init__(self, stdscr):
        self.stdscr = stdscr
        stdscr.nodelay(True)
        self.score = 0
        self.lives = START_LIVES
        self.bricks = []
        self.paddle = None
        self.ball = None
        self.state = STATE_SERVE
        self.message = ""
        self._setup_geometry()

    def _setup_geometry(self):
        max_y, max_x = self.stdscr.getmaxyx()
        self.top = 2
        self.bottom = max_y - 2
        self.left = 1
        self.right = max_x - 2
        self.too_small = max_y < MIN_ROWS or max_x < MIN_COLS

    def init_level(self):
        """Build the paddle, ball, and brick wall for a fresh level."""
        height = self.right - self.left + 1
        paddle_width = max(3, min(9, height // 6))
        self.paddle = Paddle(paddle_width)
        self.paddle.y = self.bottom - 1
        self.paddle.x = (self.left + self.right) // 2 - paddle_width // 2

        self.ball = Ball()
        self.ball.serve(self.paddle)

        self._build_bricks()
        self.score = 0
        self.lives = START_LIVES
        self.state = STATE_PLAYING

    def _build_bricks(self):
        """Construct the brick wall filling the play area."""
        self.bricks = []
        brick_w = 3
        spacing = 1
        wall_width = self.right - self.left + 1

        cols = max(1, (wall_width + spacing) // (brick_w + spacing))
        brick_rows = 6

        for row in range(brick_rows):
            y = self.top + row
            # Higher bricks are worth more and take more hits.
            durability = min(MAX_BRICK_DURABILITY, brick_rows - row)
            for col in range(cols):
                x = self.left + col * (brick_w + spacing)
                if x + brick_w - 1 > self.right:
                    break
                self.bricks.append(Brick(x, y, durability, brick_w))

    def handle_input(self):
        """Process all pending keyboard input."""
        while True:
            try:
                ch = self.stdscr.getch()
            except curses.error:
                break
            if ch == -1:
                break
            self._dispatch(ch)

    def _dispatch(self, ch):
        if ch in (ord("q"), ord("Q")):
            self.state = STATE_GAME_OVER
            self.message = "QUIT"
            return
        if self.state in (STATE_WON, STATE_GAME_OVER, STATE_TOO_SMALL):
            # Any key returns to a fresh serve.
            self.restart()
            return
        if ch == curses.KEY_LEFT or ch == ord("a"):
            self.paddle.move(-2, self.right - self.left + 1)
        elif ch == curses.KEY_RIGHT or ch == ord("d"):
            self.paddle.move(2, self.right - self.left + 1)
        elif ch in (ord(" "), curses.KEY_UP, ord("w")):
            if self.state == STATE_SERVE:
                self.ball.serve(self.paddle)
                self.state = STATE_PLAYING

    def restart(self):
        """Start a brand new game."""
        self.message = ""
        self.state = STATE_SERVE
        self.init_level()

    def update(self):
        """Advance the simulation by one frame (when playing)."""
        if self.state != STATE_PLAYING:
            return

        # Move ball with sub-integer precision for smooth motion.
        self.ball.x += self.ball.dx
        self.ball.y += self.ball.dy

        self._collide_walls()
        self._collide_paddle()
        self._collide_bricks()

        # Ball lost below the paddle.
        if self.ball.y >= self.bottom:
            self.lives -= 1
            if self.lives <= 0:
                self.state = STATE_GAME_OVER
                self.message = "GAME OVER"
            else:
                self.state = STATE_SERVE

    def _collide_walls(self):
        # Left/right walls.
        if self.ball.x <= self.left and self.ball.dx < 0:
            self.ball.x = float(self.left)
            self.ball.dx = -self.ball.dx
        elif self.ball.x >= self.right and self.ball.dx > 0:
            self.ball.x = float(self.right)
            self.ball.dx = -self.ball.dx
        # Top wall.
        if self.ball.y <= self.top and self.ball.dy < 0:
            self.ball.y = float(self.top)
            self.ball.dy = -self.ball.dy

    def _collide_paddle(self):
        px, py = self.ball.pos()
        if py == self.paddle.y - 1 and self.paddle.x <= px < self.paddle.right and self.ball.dy > 0:
            # Reflect and add a horizontal nudge based on impact point.
            self.ball.y = float(self.paddle.y - 2)
            self.ball.dy = -self.ball.dy
            offset = (px - self.paddle.center()) / (self.paddle.width / 2.0)
            self.ball.dx += offset
            # Clamp horizontal speed so the ball never gets stuck.
            if abs(self.ball.dx) < 0.3:
                self.ball.dx = 0.5 if self.ball.dx >= 0 else -0.5

    def _collide_bricks(self):
        px, py = self.ball.pos()
        hit_brick = None
        for brick in self.bricks:
            if not brick.destroyed and brick.contains(px, py):
                hit_brick = brick
                break
        if hit_brick is None:
            return

        hit_brick.hit()
        self.score += hit_brick.durability * 10 + 10

        # Determine which face was struck to reflect believably.
        cx = px - hit_brick.x
        cy = py - hit_brick.y
        half_w = hit_brick.width / 2.0
        if cy < 0:
            self.ball.dy = -abs(self.ball.dy)
        else:
            self.ball.dy = abs(self.ball.dy)
        if cx < half_w:
            self.ball.dx = -abs(self.ball.dx)
        else:
            self.ball.dx = abs(self.ball.dx)

        if hit_brick.destroyed:
            # Move the ball clear so it doesn't re-collide next frame.
            self.ball.y += self.ball.dy * 0.5

    def _remaining_bricks(self):
        return [b for b in self.bricks if not b.destroyed]

    def draw(self):
        stdscr = self.stdscr
        stdscr.erase()

        # Borders.
        for x in range(self.left, self.right + 1):
            stdscr.addch(self.top - 1, x, CHAR_WALL)
            stdscr.addch(self.bottom, x, CHAR_WALL)
        for y in range(self.top, self.bottom + 1):
            stdscr.addch(y, self.left - 1, CHAR_WALL)
            stdscr.addch(y, self.right + 1, CHAR_WALL)

        # Status line (top).
        status = "Score: {}  Lives: {}".format(self.score, self.lives)
        stdscr.addstr(self.top - 2, self.left, status[: self.right - self.left + 1])

        # Bricks.
        for brick in self.bricks:
            if brick.destroyed:
                continue
            row = CHAR_BRICK * brick.width
            stdscr.addstr(brick.y, brick.x, row)

        # Paddle.
        px, py = self.ball.pos() if False else (self.paddle.x, self.paddle.y)
        stdscr.addstr(self.paddle.y, self.paddle.x, CHAR_PADDLE * self.paddle.width)

        # Ball.
        bx, by = self.ball.pos()
        if self.top <= by < self.bottom and self.left <= bx <= self.right:
            stdscr.addch(by, bx, CHAR_BALL)

        # Win / game-over overlay.
        if self.state == STATE_WON:
            self._overlay("YOU WIN!  Press any key to play again.")
        elif self.state == STATE_GAME_OVER:
            self._overlay(self.message or "GAME OVER  Press any key.")
        elif self.state == STATE_SERVE:
            self._overlay("Press SPACE to serve.  q to quit.")
        elif self.state == STATE_TOO_SMALL:
            self._overlay(self.message)

        stdscr.refresh()

    def _overlay(self, text):
        max_y, max_x = self.stdscr.getmaxyx()
        y = max_y // 2
        x = max(0, (max_x - len(text)) // 2)
        # Use standout/reverse so the message stands out from the game.
        try:
            self.stdscr.addstr(y, x, text, curses.A_REVERSE)
        except curses.error:
            pass

    def check_win(self):
        if self.state == STATE_PLAYING and not self._remaining_bricks():
            self.state = STATE_WON
            self.message = "YOU WIN"
            self.score += 1000

    def run(self):
        """Main game loop."""
        # Initialize the first level.
        self.init_level()

        while self.state != STATE_GAME_OVER or self.message == "QUIT":
            self.handle_input()

            if self.too_small:
                self.state = STATE_TOO_SMALL
                self.message = "Terminal too small. Resize to {}x{} or larger."\
                    .format(MIN_ROWS, MIN_COLS)
            else:
                if self.state == STATE_SERVE:
                    # Keep the ball parked on the paddle.
                    self.ball.serve(self.paddle)
                elif self.state == STATE_PLAYING:
                    self.update()
                    self.check_win()

            self.draw()
            curses.napms(int(BALL_ADVANCE_PAUSE * 1000))

        return self.score


def main(stdscr):
    """curses entry point."""
    # Configure curses for real-time rendering.
    curses.curs_set(0)
    stdscr.keypad(True)
    curses.noecho()
    curses.cbreak()

    game = Game(stdscr)
    game.run()

    # Restore terminal state before exiting.
    curses.nocbreak()
    stdscr.keypad(False)
    curses.echo()
    curses.curs_set(1)


if __name__ == "__main__":
    # curses.wrapper handles setup/teardown so the terminal is restored
    # correctly even if an exception is raised.
    curses.wrapper(main)
