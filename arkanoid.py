#!/usr/bin/env python3
"""Arkanoid (Breakout) game drawn entirely with text characters using curses.

Run: python3 arkanoid.py

Controls:
  Left/Right arrow keys (or 'a'/'d') to move the paddle.
  'q' or Esc to quit at any time.
"""

import curses
import random
import time

# Minimum terminal size required to play.
MIN_HEIGHT = 20
MIN_WIDTH = 60

# Game constants.
PADDLE_WIDTH = 7
BALL_SYMBOL = "O"
PADDLE_SYMBOL = "="
BRICK_SYMBOLS = ["#", "%", "&", "*", "+", "?", "@"]
EMPTY = " "

FRAME_DELAY = 0.016  # ~60 FPS target.
BALL_SPEED_X = 1
BALL_SPEED_Y = 1

# Brick grid layout.
BRICK_ROWS = 6
BRICK_COLS = 12
BRICK_PADDING_X = 1


class Brick:
    """A single brick with a position, hit points, and visual symbol."""

    def __init__(self, x, y, symbol, hits=1):
        self.x = x
        self.y = y
        self.symbol = symbol
        self.hits = hits

    def hit(self):
        """Register a hit; return True if the brick is destroyed."""
        if self.hits > 0:
            self.hits -= 1
        return self.hits == 0


class Ball:
    """The ball with position and velocity."""

    def __init__(self, x, y):
        self.x = x
        self.y = y
        self.dx = BALL_SPEED_X
        self.dy = -BALL_SPEED_Y

    def reset(self, x, y):
        self.x = x
        self.y = y
        self.dx = 0
        self.dy = 0


class Paddle:
    """The player's paddle."""

    def __init__(self, x, width):
        self.x = x
        self.width = width

    def move(self, delta, max_x):
        """Move the paddle, clamped to the playfield."""
        self.x = max(1, min(self.x + delta, max_x - self.width - 1))


class Game:
    """Top-level game state and logic."""

    def __init__(self, height, width):
        self.height = height
        self.width = width
        self.score = 0
        self.lives = 3
        self.state = "playing"  # playing | win | gameover

        self.ball = Ball(0, 0)
        self.paddle = Paddle(0, PADDLE_WIDTH)
        self.bricks = self._build_bricks()

        self._reset_ball_and_paddle()

    def _build_bricks(self):
        """Build the brick grid at the top of the playfield."""
        bricks = []
        top = 2
        brick_w = 2
        span = BRICK_COLS * brick_w + (BRICK_COLS - 1) * BRICK_PADDING_X
        start_x = (self.width - span) // 2
        for row in range(BRICK_ROWS):
            if top + row >= self.height - 4:
                break
            hits = (row % 3) + 1
            symbol = BRICK_SYMBOLS[row % len(BRICK_SYMBOLS)]
            for col in range(BRICK_COLS):
                x = start_x + col * (brick_w + BRICK_PADDING_X)
                if x < 1 or x + brick_w >= self.width - 1:
                    continue
                bricks.append(Brick(x, top + row, symbol, hits))
        return bricks

    def _reset_ball_and_paddle(self):
        """Place the ball on the paddle for the next serve."""
        self.paddle.x = (self.width // 2) - (self.paddle.width // 2)
        self.ball.reset(self.paddle.x + self.paddle.width // 2, self.height - 3)

    def serve(self):
        """Launch the ball from the paddle."""
        self.ball.reset(self.paddle.x + self.paddle.width // 2, self.height - 3)
        self.ball.dx = BALL_SPEED_X * random.choice([-1, 1])
        self.ball.dy = -BALL_SPEED_Y

    def update(self):
        """Advance the game one step."""
        if self.state != "playing":
            return

        if self.ball.dx == 0 and self.ball.dy == 0:
            return

        self.ball.x += self.ball.dx
        self.ball.y += self.ball.dy

        # Bounce off left/right walls.
        if self.ball.x <= 0 or self.ball.x >= self.width - 1:
            self.ball.dx = -self.ball.dx

        # Bounce off the top wall.
        if self.ball.y <= 0:
            self.ball.dy = -self.ball.dy

        # Bounce off the paddle.
        paddle_top = self.height - 3
        if self.ball.y >= paddle_top and self.ball.dy > 0:
            if self.paddle.x <= self.ball.x < self.paddle.x + self.paddle.width:
                self.ball.dy = -self.ball.dy
                self.ball.y = paddle_top - 1
                offset = (self.ball.x - self.paddle.x) - (self.paddle.width / 2)
                if abs(offset) > self.paddle.width / 3:
                    self.ball.dx = BALL_SPEED_X * 2
                    if self.ball.x < self.paddle.x:
                        self.ball.dx = -self.ball.dx
            else:
                # Ball passed the paddle vertically.
                if self.ball.y >= paddle_top:
                    self._lose_life()
                    return

        # Ball fell below the paddle.
        if self.ball.y >= self.height - 1:
            self._lose_life()
            return

        # Check brick collisions.
        self._check_brick_collisions()

        # Check win condition.
        if not self.bricks:
            self.state = "win"

    def _lose_life(self):
        """Handle losing a life."""
        self.lives -= 1
        if self.lives <= 0:
            self.state = "gameover"
        else:
            self._reset_ball_and_paddle()

    def _check_brick_collisions(self):
        """Check and resolve collisions with bricks."""
        for brick in self.bricks:
            if brick.y == self.ball.y and brick.x <= self.ball.x < brick.x + 2:
                self.ball.dy = -self.ball.dy
                if brick.hit():
                    self.bricks.remove(brick)
                self.score += 10
                return

    def move_paddle(self, delta):
        """Move the paddle if the game is in the playing state."""
        if self.state != "playing":
            return
        self.paddle.move(delta, self.width)

    def serve_if_ready(self):
        """Serve the ball if it is currently stationary."""
        if self.state != "playing":
            return
        if self.ball.dx == 0 and self.ball.dy == 0:
            self.serve()


def draw_game(stdscr, game):
    """Render the full game to the curses window."""
    stdscr.erase()
    height, width = game.height, game.width

    # Top border.
    stdscr.addstr(0, 0, "+" + "-" * (width - 2) + "+")
    # Side borders.
    for y in range(1, height - 1):
        stdscr.addch(y, 0, "|")
        stdscr.addch(y, width - 1, "|")
    # Bottom border.
    stdscr.addstr(height - 1, 0, "+" + "-" * (width - 2) + "+")

    # Draw bricks.
    for brick in game.bricks:
        for i in range(2):
            bx = brick.x + i
            if 1 <= bx < width - 1:
                try:
                    stdscr.addch(brick.y, bx, brick.symbol)
                except curses.error:
                    pass

    # Draw the paddle.
    for i in range(game.paddle.width):
        px = game.paddle.x + i
        if 1 <= px < width - 1:
            try:
                stdscr.addch(game.height - 3, px, PADDLE_SYMBOL)
            except curses.error:
                pass

    # Draw the ball.
    bx, by = int(game.ball.x), int(game.ball.y)
    if 1 <= bx < width - 1 and 1 <= by < height - 1:
        try:
            stdscr.addch(by, bx, BALL_SYMBOL)
        except curses.error:
            pass

    # Status bar: score and lives.
    status = " SCORE: {}  LIVES: {}  STATE: {} ".format(
        game.score, game.lives, game.state.upper()
    )
    try:
        stdscr.addstr(0, 1, status[: width - 2])
    except curses.error:
        pass

    stdscr.refresh()


def draw_message(stdscr, message):
    """Draw a centered multi-line message."""
    stdscr.erase()
    height, width = stdscr.getmaxyx()
    if height < MIN_HEIGHT or width < MIN_WIDTH:
        try:
            stdscr.addstr(0, 0, "Terminal too small.")
        except curses.error:
            pass
        stdscr.refresh()
        return
    lines = message.split("\n")
    start_y = max(1, (height - len(lines)) // 2)
    for i, line in enumerate(lines):
        x = max(0, (width - len(line)) // 2)
        y = min(start_y + i, height - 1)
        try:
            stdscr.addstr(y, x, line[: width - 1])
        except curses.error:
            pass
    stdscr.refresh()


def run(stdscr):
    """Main game loop."""
    # Configure curses.
    curses.curs_set(0)
    stdscr.keypad(True)
    stdscr.nodelay(True)
    stdscr.timeout(0)

    height, width = stdscr.getmaxyx()
    if height < MIN_HEIGHT or width < MIN_WIDTH:
        draw_message(
            stdscr,
            "Terminal too small!\n"
            "Resize to at least {}x{}.".format(MIN_HEIGHT, MIN_WIDTH),
        )
        stdscr.nodelay(False)
        stdscr.getch()
        return

    game = Game(height, width)

    # Initial serve prompt.
    draw_message(
        stdscr,
        "ARKANOID\n"
        "ARROW KEYS / A-D : Move paddle\n"
        "Q / ESC : Quit\n"
        "Press any key to start...",
    )
    stdscr.nodelay(False)
    stdscr.getch()

    game.serve()
    last_time = time.time()

    while True:
        # Handle input.
        key = stdscr.getch()
        if key in (ord("q"), ord("Q"), 27):  # 27 is Escape.
            break
        elif key in (curses.KEY_LEFT, ord("a"), ord("A")):
            game.move_paddle(-1)
        elif key in (curses.KEY_RIGHT, ord("d"), ord("D")):
            game.move_paddle(1)
        elif key in (curses.KEY_UP, ord(" ")):
            game.serve_if_ready()
        elif key == curses.KEY_RESIZE:
            h, w = stdscr.getmaxyx()
            if h < MIN_HEIGHT or w < MIN_WIDTH:
                draw_message(
                    stdscr,
                    "Terminal too small!\n"
                    "Resize to at least {}x{}.".format(MIN_HEIGHT, MIN_WIDTH),
                )
                stdscr.nodelay(False)
                stdscr.getch()
                break
            game.height, game.width = h, w
            game.bricks = game._build_bricks()
        elif game.state != "playing" and key in (
            ord("r"),
            ord("R"),
            curses.KEY_ENTER,
            10,
        ):
            game = Game(game.height, game.width)
            game.serve()

        # Time-based update.
        now = time.time()
        if now - last_time >= FRAME_DELAY:
            game.update()
            last_time = now

        draw_game(stdscr, game)

        # Check end states.
        if game.state == "win":
            draw_message(
                stdscr,
                "YOU WIN!\nFinal Score: {}\nPress any key to exit.".format(game.score),
            )
            stdscr.nodelay(False)
            stdscr.getch()
            break
        elif game.state == "gameover":
            draw_message(
                stdscr,
                "GAME OVER\nFinal Score: {}\nPress any key to exit.".format(game.score),
            )
            stdscr.nodelay(False)
            stdscr.getch()
            break

        time.sleep(0.001)


def main():
    try:
        curses.wrapper(run)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
