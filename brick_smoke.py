#!/usr/bin/env python3
"""brick_smoke.py - A self-contained curses Breakout/Arkanoid game."

A classic Breakout / Arkanoid game drawn entirely with text characters.
Uses only the Python 3 standard library (curses).

Controls:
  Left arrow   - move paddle left
  Right arrow  - move paddle right
  Space        - restart after win / game over
  'q' or ESC   - quit

Run: python3 brick_smoke.py
"""

import curses
import random
import time


# -----------------------------------------------------------------------------
# Configuration constants
# -----------------------------------------------------------------------------

PLAYFIELD_WIDTH = 60
PLAYFIELD_HEIGHT = 24
PADDLE_WIDTH = 9
NUM_BRICK_ROWS = 8
NUM_BRICK_COLS = 14
NUM_LIVES = 3
BALL_CHAR = 'O'
PADDLE_CHAR = '='

# Brick characters cycle through these to add visual variety.
BRICK_CHARS = ['#', '/', '%', '&']

# How many frames to skip between updates (controls game speed).
FRAME_DELAY = 0.016  # ~60 FPS target


class Status:
    """Game status enum."""
    PLAYING = 'PLAYING'
    WON = 'WON'
    GAME_OVER = 'GAME_OVER'
    TOO_SMALL = 'TOO_SMALL'


class Brick:
    """A single brick in the wall."""
    __slots__ = ('x', 'y', 'char')

    def __init__(self, x, y, char):
        self.x = x
        self.y = y
        self.char = char

    def __repr__(self):
        return 'Brick(x={}, y={}, char={!r})'.format(self.x, self.y, self.char)


class Game:
    """Core game state and logic for the Breakout game."""

    def __init__(self):
        self.width = PLAYFIELD_WIDTH
        self.height = PLAYFIELD_HEIGHT
        self.paddle_w = PADDLE_WIDTH
        self.reset()

    def reset(self):
        """Reset all game state for a new game."""
        self.status = Status.PLAYING
        self.score = 0
        self.lives = NUM_LIVES
        self.bricks = self._build_brick_wall()
        self._reset_ball_and_paddle()

    def _build_brick_wall(self):
        """Build the initial grid of bricks."""
        bricks = []
        # Leave room at the top for score/lives display.
        wall_top = 2
        brick_w = 3  # each brick occupies 3 chars horizontally (plus 1 gap)
        for row in range(NUM_BRICK_ROWS):
            char = BRICK_CHARS[row % len(BRICK_CHARS)]
            for col in range(NUM_BRICK_COLS):
                x = 2 + col * (brick_w + 1)
                y = wall_top + row
                bricks.append(Brick(x, y, char))
        return bricks

    def _reset_ball_and_paddle(self):
        """Place the paddle and ball for a new serve."""
        # Paddle centered near the bottom.
        self.paddle_x = (self.width - self.paddle_w) // 2
        # Ball rests on top of the paddle.
        self.ball_x = self.paddle_x + self.paddle_w // 2
        self.ball_y = self.height - 4
        # Gentle, slightly random serve direction: moving up and toward a side.
        direction = random.choice([-1, 1])
        self.ball_dx = direction * random.uniform(0.6, 0.9)
        # Always serve upward initially.
        self.ball_vy = -1.0
        self.ball_vx = self.ball_dx
        self.serving = True

    def move_paddle(self, delta):
        """Move the paddle by 'delta' (negative=left, positive=right)."""
        new_x = self.paddle_x + delta
        if new_x < 1:
            new_x = 1
        if new_x + self.paddle_w > self.width - 1:
            new_x = self.width - 1 - self.paddle_w
        self.paddle_x = new_x

    def serve_ball(self):
        """Launch the ball for a new serve."""
        self._reset_ball_and_paddle()
        # Small upward velocity with slight horizontal drift.
        direction = random.choice([-1, 1])
        self.ball_vx = direction * random.uniform(0.6, 0.9)
        self.ball_vy = -1.0
        self.serving = False

    def update(self):
        """Advance the game physics by one tick."""
        if self.status != Status.PLAYING:
            return
        if self.serving:
            # During serve, the ball tracks the paddle horizontally for a moment.
            self.ball_x = self.paddle_x + self.paddle_w // 2
            return

        new_x = self.ball_x + self.ball_vx
        new_y = self.ball_y + self.ball_vy

        # Horizontal wall bounce.
        if new_x <= 0:
            new_x = 0
            self.ball_vx = abs(self.ball_vx)
        elif new_x >= self.width - 1:
            new_x = self.width - 1
            self.ball_vx = -abs(self.ball_vx)

        # Vertical wall: ceiling bounce.
        if new_y <= 0:
            new_y = 0
            if self.ball_vy < 0:
                self.ball_vy = -self.ball_vy

        self.ball_x = new_x
        self.ball_y = new_y

        # Bottom: ball lost.
        bottom_limit = self.height - 3  # space reserved for score/lives
        if self.ball_y > bottom_limit:
            self.lives -= 1
            if self.lives <= 0:
                self.status = Status.GAME_OVER
            else:
                self._reset_ball_and_paddle()
                self.serving = True
            return

        self._check_brick_collisions()
        self._check_paddle_collision()

        # Win condition.
        if not self.bricks:
            self.status = Status.WON

    def _check_brick_collisions(self):
        """Detect and resolve collisions between the ball and bricks."""
        cx = round(self.ball_x)
        cy = round(self.ball_y)

        for brick in list(self.bricks):
            # A brick occupies (brick_w) chars starting at brick.x on brick.y.
            brick_w = 3
            if brick.y == cy and brick.x <= cx < brick.x + brick_w:
                self.bricks.remove(brick)
                self.score += 10
                # Reverse vertical direction; nudge horizontal for liveliness.
                self.ball_vy = -self.ball_vy
                if abs(self.ball_vx) < 0.2:
                    self.ball_vx = random.uniform(-0.5, 0.5)
                # Move ball out of the brick to prevent sticking.
                self.ball_y = cy + self.ball_vy
                return
            # Also check the row just above/below for thicker detection.
            if brick.y in (cy - 1, cy + 1) and brick.x <= cx < brick.x + brick_w:
                self.bricks.remove(brick)
                self.score += 10
                self.ball_vy = -self.ball_vy
                if abs(self.ball_vx) < 0.2:
                    self.ball_vx = random.uniform(-0.5, 0.5)
                return

    def _check_paddle_collision(self):
        """Detect and resolve collision between the ball and the paddle."""
        cx = round(self.ball_x)
        cy = round(self.ball_y)
        paddle_top = self.height - 3
        paddle_bottom = paddle_top + 1

        if cy in (paddle_top, paddle_bottom) and \
                self.paddle_x <= cx < self.paddle_x + self.paddle_w:
            # Reverse vertical and add a horizontal deflection based on impact point.
            self.ball_vy = -abs(self.ball_vy)
            offset = (cx - self.paddle_x) / self.paddle_w - 0.5
            self.ball_vx += offset * 2.0
            # Clamp horizontal speed.
            speed = (self.ball_vx ** 2 + self.ball_vy ** 2) ** 0.5
            if speed > 0:
                max_speed = 2.5
                if speed > max_speed:
                    self.ball_vx = self.ball_vx / speed * max_speed
                    self.ball_vy = self.ball_vy / speed * max_speed
            # Lift the ball above the paddle to avoid sticking.
            self.ball_y = paddle_top - 1

    def restart(self):
        """Restart the game from scratch."""
        self.reset()

    def too_small(self, max_y, max_x):
        """Check whether the terminal is large enough for the playfield."""
        return max_y < self.height + 2 or max_x < self.width + 2

    # -----------------------------------------------------------------------
    # Rendering
    # -----------------------------------------------------------------------

    def draw(self, stdscr):
        """Draw the entire game scene onto the curses window."""
        stdscr.erase()
        max_y, max_x = stdscr.getmaxyx()

        if self.too_small(max_y, max_x):
            self.status = Status.TOO_SMALL
            self._draw_too_small(stdscr, max_y, max_x)
            return

        # Draw a border around the playfield.
        self._draw_border(stdscr)

        # Draw bricks.
        for brick in self.bricks:
            try:
                stdscr.addch(brick.y, brick.x, brick.char,
                             curses.color_pair(1))
            except curses.error:
                pass

        # Draw paddle.
        paddle_y = self.height - 3
        for i in range(self.paddle_w):
            try:
                stdscr.addch(paddle_y, self.paddle_x + i, PADDLE_CHAR,
                             curses.color_pair(2))
            except curses.error:
                pass

        # Draw ball.
        try:
            stdscr.addch(round(self.ball_y), round(self.ball_x), BALL_CHAR,
                         curses.color_pair(3))
        except curses.error:
            pass

        # Draw score and lives header.
        header = ' SCORE: {}  LIVES: {}  STATUS: {}'.format(
            self.score, self.lives, self.status)
        for i, ch in enumerate(header):
            if 0 < i < max_x - 1:
                try:
                    stdscr.addch(0, i, ch)
                except curses.error:
                    pass

        # Draw status messages.
        if self.status == Status.WON:
            msg = '  *** YOU WON! ***  Press SPACE to restart, Q to quit.'
            self._draw_centered(stdscr, self.height // 2, msg)
        elif self.status == Status.GAME_OVER:
            msg = '  *** GAME OVER ***  Press SPACE to restart, Q to quit.'
            self._draw_centered(stdscr, self.height // 2, msg)

        stdscr.refresh()

    def _draw_border(self, stdscr):
        """Draw a simple border around the playfield."""
        top = 1
        bottom = self.height - 1
        left = 0
        right = self.width - 1
        # Top and bottom edges.
        for x in range(left, right + 1):
            try:
                stdscr.addch(top, x, '-')
                stdscr.addch(bottom, x, '-')
            except curses.error:
                pass
        # Left and right edges.
        for y in range(top, bottom + 1):
            try:
                stdscr.addch(y, left, '|')
                stdscr.addch(y, right, '|')
            except curses.error:
                pass
        # Corners.
        for (y, x) in [(top, left), (top, right), (bottom, left), (bottom, right)]:
            try:
                stdscr.addch(y, x, '+')
            except curses.error:
                pass

    def _draw_centered(self, stdscr, y, msg):
        """Draw a message horizontally centered at row 'y'."""
        max_y, max_x = stdscr.getmaxyx()
        start = (max_x - len(msg)) // 2
        if start < 1:
            start = 1
        for i, ch in enumerate(msg):
            if start + i < max_x - 1:
                try:
                    stdscr.addch(y, start + i, ch)
                except curses.error:
        if self.state in (GameState.WON, GameState.GAME_OVER):
            if low == "r":
                self.start_new_game()
                return
            return
        # While playing, allow quit at any time.
        if low == "q":
            self._quit = True

    def _draw_too_small(self, stdscr, max_y, max_x):
        """Draw a 'terminal too small' message."""
        msg = 'Terminal too small. Need at least {}x{} (got {}x{}).'.format(MIN_TERMINAL_WIDTH, MIN_TERMINAL_HEIGHT, max_x, max_y)
' +
               '   Resize your terminal and restart the game.').format(
            self.width + 2, self.height + 2, max_x, max_y)
        # Render the two part message.
        lines = msg.split('\n')
        start_y = (max_y - len(lines)) // 2
        for i, line in enumerate(lines):
            y = start_y + i
            if 0 < y < max_y - 1:
                self._draw_centered_at(stdscr, y, line)
        stdscr.refresh()

    def _draw_centered_at(self, stdscr, y, msg):
        """Draw a message centered at a given row."""
        max_y, max_x = stdscr.getmaxyx()
        start = (max_x - len(msg)) // 2
        if start < 1:
            start = 1
        for i, ch in enumerate(msg):
            if start + i < max_x - 1:
                try:
                    stdscr.addch(y, start + i, ch)
                except curses.error:
                    pass


def setup_curses(stdscr):
    """Initialize curses color pairs and settings."""
    curses.curs_set(0)  # Hide cursor.
    stdscr.nodelay(True)  # Non-blocking input.
    stdscr.keypad(True)
    try:
        curses.start_color()
        curses.use_default_colors()
        curses.init_pair(1, curses.COLOR_RED, -1)
        curses.init_pair(2, curses.COLOR_GREEN, -1)
        curses.init_pair(3, curses.COLOR_YELLOW, -1)
    except curses.error:
        pass
    return stdscr


def handle_input(stdscr, game):
    """Process a single input event and return True if the program should quit."""
    try:
        key = stdscr.getch()
    except curses.error:
        return False
n    if key == -1:
        return False
    if key in (ord('q'), ord('Q'), 27):  # 27 = ESC
        return True
    if key == curses.KEY_LEFT:
        game.move_paddle(-2)
    elif key == curses.KEY_RIGHT:
        game.move_paddle(2)
    elif key == ord(' '):
        # Restart on win / game over.
        if game.status in (Status.WON, Status.GAME_OVER):
            game.restart()
        elif game.status == Status.TOO_SMALL:
            game.restart()
        else:
            # During play, space serves the ball if it hasn't launched yet.
            if game.serving:
                game.serve_ball()
    return False


def main(stdscr):
    """Main game entry point called by curses.wrapper."""
    setup_curses(stdscr)
    game = Game()

    running = True
    while running:
        # Auto-serve the ball shortly after a reset for smoother gameplay.
        if game.status == Status.PLAYING and game.serving:
            # Give the player a brief moment before auto-serving.
            pass

        # Handle input.
        quit_requested = handle_input(stdscr, game)
        if quit_requested:
            break

        # Update physics.
        game.update()

        # Render everything.
        game.draw(stdscr)

        # Control frame rate.
        time.sleep(FRAME_DELAY)

    # Clean exit message.
    stdscr.erase()
    try:
        stdscr.addstr(0, 0, 'Thanks for playing brick_smoke! Final score: {}'.format(game.score))
        stdscr.refresh()
        time.sleep(0.5)
    except curses.error:
        pass


if __name__ == '__main__':
    try:
        curses.wrapper(main)
    except KeyboardInterrupt:
        pass
