#!/usr/bin/env python3
"""mutation_turn_smoke.py - a small Breakout/Arkanoid game built with curses.

A disposable harness smoke-test program that validates a large single-session
mutation turn. Runs in an Ubuntu terminal using only the Python standard
library. Move the paddle with the left/right arrow keys (or 'a'/'d'), launch a
new serve, restart after a win or game over, and quit.
"""

import curses
import random
import sys

# Project name, exactly as declared in [project].name of pyproject.toml.
PROJECT_NAME = "social-mcp"

# Gameplay constants.
MIN_HEIGHT = 20
MIN_WIDTH = 60
PADDLE_WIDTH = 9
BALL_CHAR = "O"
PADDLE_CHAR = "="
BRICK_CHARS = ["#", "%", "&", "@"]
TOP_BORDER = "="
SIDE_BORDER = "|"
CORNER = "+"
EMPTY = " "

# Scoring.
POINTS_PER_BRICK = 10
LIVES_START = 5
SPEED_LEVEL_UP = 5  # bricks remaining threshold to level up speed


def build_help_text():
    """Return on-screen help lines built from a normal string literal.

    The literal uses ordinary \\n escape sequences so the lines are split for
    display without requiring a triple-quoted block.
    """
    raw = "Move: Left/Right arrows (or A/D)\n\nBounce the ball to break bricks.\n\nClear all bricks to WIN.\n\nLose all lives -> GAME OVER.\n\nRestart: R or any key.\nQuit: Q or Ctrl-C."
    return raw.split("\n")


def build_bricks(height, width):
    """Build a grid of bricks near the top of the playfield."""
    brick_height = 5
    brick_rows = min(brick_height, height // 4)
    start_row = 2
    col_gap = 2
    bricks = []
    row = start_row
    for r in range(brick_rows):
        chars = ["#", "%", "&", "@"]
        char = chars[r % len(chars)]
        col = col_gap
        while col + 1 < width - col_gap:
            bricks.append({"row": row, "col": col, "char": char})
            col += 2  # each brick is one character cell wide, spaced by one
        row += 1
    return bricks


class GameState:
    """Mutable game state for a single in-memory playthrough."""

    def __init__(self, height, width):
        self.height = height
        self.width = width
        self.margin = 1
        self.play_top = 3
        self.play_bottom = height - 3
        self.play_left = 2
        self.play_right = width - 3
        self.reset()

    def reset(self, full=False):
        """Reset ball/paddle (full=True also resets lives and score)."""
        if full:
            self.lives = LIVES_START
            self.score = 0
        # Paddle.
        self.paddle_col = (self.play_left + self.play_right) // 2
        self.ball_col = self.paddle_col
        self.ball_row = self.play_bottom - 1
        # Ball velocity: aim upward, slightly randomized so serves vary.
        self.ball_dy = -1
        self.ball_dx = random.choice([-2, -1, 1, 2])
        self.serving = True
        self.status = "playing"  # playing, won, game_over
        # Bricks only on a full reset.
        if full:
            self.bricks = build_bricks(self.height, self.width)
        self.speed_tick = 0

    def move_paddle(self, delta):
        """Move the paddle by delta columns, clamped to the playfield."""
        new_col = self.paddle_col + delta
        half = PADDLE_WIDTH // 2
        lo = self.play_left + half
        hi = self.play_right - half
        self.paddle_col = max(lo, min(hi, new_col))
        if self.serving:
            # Keep the serve position centered on the paddle.
            self.ball_col = self.paddle_col

    def update(self):
        """Advance one physics tick. Returns True if a state change occurred."""
        if self.status in ("won", "game_over") or self.serving:
            return False

        prev_col = self.ball_col
        prev_row = self.ball_row
        new_col = self.ball_col + self.ball_dx
        new_row = self.ball_row + self.ball_dy

        # Horizontal wall bounce.
        if new_col <= self.play_left or new_col >= self.play_right:
            self.ball_dx = -self.ball_dx
            new_col = self.ball_col + self.ball_dx
            self.ball_col = new_col
        else:
            self.ball_col = new_col

        # Vertical top/bottom.
        if new_row <= self.play_top:
            self.ball_dy = -self.ball_dy
            self.ball_row = self.play_top + 1
        elif new_row >= self.play_bottom:
            # Ball fell below the paddle.
            self.lives -= 1
            if self.lives <= 0:
                self.status = "game_over"
            else:
                self.serving = True
                self.ball_col = self.paddle_col
                self.ball_row = self.play_bottom - 1
                self.ball_dy = -1
                self.ball_dx = random.choice([-2, -1, 1, 2])
            return True
        else:
            self.ball_row = new_row

        # Paddle bounce: check collision with the paddle surface.
        if self.ball_row == self.play_bottom - 1 and self.serving is False:
            half = PADDLE_WIDTH // 2
            paddle_left = self.paddle_col - half
            paddle_right = self.paddle_col + half
            if paddle_left <= self.ball_col <= paddle_right and self.ball_dy > 0:
                self.ball_dy = -self.ball_dy
                # Add a little horizontal variation based on where it hit.
                offset = self.ball_col - self.paddle_col
                if abs(offset) >= 2:
                    self.ball_dx += 1 if offset > 0 else -1
                # Clamp speed.
                if self.ball_dx > 3:
                    self.ball_dx = 3
                if self.ball_dx < -3:
                    self.ball_dx = -3
                self.ball_row = self.play_bottom - 2
                return True

        # Brick collision.
        for brick in list(self.bricks):
            if brick["row"] == self.ball_row and brick["col"] == self.ball_col:
                self.bricks.remove(brick)
                self.score += POINTS_PER_BRICK
                # Reverse the appropriate axis based on approach direction.
                if prev_row != self.ball_row:
                    self.ball_dy = -self.ball_dy
                if abs(prev_col - self.ball_col) > 0:
                    self.ball_dx = -self.ball_dx
                if not self.bricks:
                    self.status = "won"
                return True

        return False


def draw_border(stdscr, height, width):
    """Draw a simple border around the playfield."""
    top = 3
    bottom = height - 3
    left = 2
    right = width - 3
    stdscr.addstr(top - 1, left, TOP_BORDER * (right - left + 1))
    for row in range(top, bottom):
        stdscr.addch(row, left - 1, SIDE_BORDER)
        stdscr.addch(row, right + 1, SIDE_BORDER)
    stdscr.addstr(bottom + 1, left, TOP_BORDER * (right - left + 1))
    stdscr.addch(top - 1, left - 1, CORNER)
    stdscr.addch(top - 1, right + 1, CORNER)
    stdscr.addch(bottom + 1, left - 1, CORNER)
    stdscr.addch(bottom + 1, right + 1, CORNER)


def draw_status(stdscr, state):
    """Draw score, lives, and status lines."""
    height, width = stdscr.getmaxyx()
    score_line = "SCORE: %d" % state.score
    lives_line = "LIVES: %d" % state.lives
    stdscr.addstr(0, 2, score_line)
    stdscr.addstr(0, width - len(lives_line) - 2, lives_line)
    if state.status == "won":
        msg = "*** YOU WIN ***  PRESS ANY KEY TO RESTART"
        stdscr.addstr(height // 2, max(2, (width - len(msg)) // 2), msg)
    elif state.status == "game_over":
        msg = "*** GAME OVER ***  PRESS ANY KEY TO RESTART"
        stdscr.addstr(height // 2, max(2, (width - len(msg)) // 2), msg)


def draw_help(stdscr, state):
    """Draw help lines on the right side when the game is in a terminal state."""
    if state.status not in ("won", "game_over"):
        return
    height, width = stdscr.getmaxyx()
    lines = build_help_text()
    start_col = width - max(len(l) for l in lines) - 4
    start_col = max(2, start_col)
    start_row = (height // 2) + 3
    for i, line in enumerate(lines):
        r = start_row + i
        if r < height - 1:
            stdscr.addstr(r, start_col, line)


def render(stdscr, state):
    """Render the full game frame."""
    height, width = stdscr.getmaxyx()
    stdscr.erase()

    # Title banner with the exact project name from pyproject.toml.
    banner = "%s BREAKOUT" % PROJECT_NAME
    stdscr.addstr(1, 2, banner, curses.A_BOLD)

    draw_border(stdscr, height, width)
    draw_status(stdscr, state)
    draw_help(stdscr, state)

    # Bricks.
    for brick in state.bricks:
        if 0 <= brick["row"] < height and 0 <= brick["col"] < width:
            try:
                stdscr.addch(brick["row"], brick["col"], brick["char"],
                             curses.color_pair(1))
            except curses.error:
                pass

    # Paddle.
    half = PADDLE_WIDTH // 2
    paddle_left = state.paddle_col - half
    paddle_right = state.paddle_col + half
    for col in range(paddle_left, paddle_right + 1):
        if 0 <= state.play_bottom - 1 < height and 0 <= col < width:
            try:
                stdscr.addch(state.play_bottom - 1, col, PADDLE_CHAR)
            except curses.error:
                pass

    # Ball.
    if 0 <= state.ball_row < height and 0 <= state.ball_col < width:
        try:
            stdscr.addch(state.ball_row, state.ball_col, BALL_CHAR,
                         curses.color_pair(2))
        except curses.error:
            pass

    stdscr.refresh()


def handle_input(stdscr, state):
    """Process one input event. Returns True to continue running."""
    key = stdscr.getch()
    height, width = stdscr.getmaxyx()

    if key in (ord("q"), ord("Q"), 3):  # 'q' or Ctrl-C.
        return False

    # In a terminal state, any key (other than quit) restarts.
    if state.status in ("won", "game_over"):
        state.reset(full=True)
        return True

    # Controls only matter while actively playing.
    if key in (curses.KEY_LEFT, ord("a"), ord("A")):
        state.move_paddle(-2)
    elif key in (curses.KEY_RIGHT, ord("d"), ord("D")):
        state.move_paddle(2)
    elif key in (ord("r"), ord("R")):
        state.reset(full=True)
    elif key in (ord(" "), 10, 13):  # space, enter.
        if state.serving:
            state.serving = False
    return True


def main(stdscr):
    """Main curses entry point wrapped by curses.wrapper."""
    curses.curs_set(0)
    stdscr.nodelay(False)
    stdscr.keypad(True)

    # Set up colors if available.
    if curses.has_colors():
        curses.start_color()
        curses.use_default_colors()
        if curses.can_change_color():
            curses.init_pair(1, curses.COLOR_YELLOW, -1)  # bricks
            curses.init_pair(2, curses.COLOR_WHITE, -1)   # ball
        else:
            curses.init_pair(1, curses.COLOR_YELLOW, -1)
            curses.init_pair(2, curses.COLOR_WHITE, -1)

    rng = random.Random()
    random.seed()

    height, width = stdscr.getmaxyx()
    if height < MIN_HEIGHT or width < MIN_WIDTH:
        stdscr.erase()
        msg = ("Terminal too small. Need at least %dx%d, got %dx%d.\n"
               "Resize your terminal and run again." % (MIN_WIDTH, MIN_HEIGHT,
                                                        width, height))
        lines = msg.split("\n")
        for i, line in enumerate(lines):
            stdscr.addstr(height // 2 - len(lines) // 2 + i,
                          max(2, (width - len(line)) // 2), line)
        stdscr.refresh()
        stdscr.getch()
        return

    state = GameState(height, width)
    state.reset(full=True)

    # Initial serve pause.
    render(stdscr, state)
    stdscr.getch()

    running = True
    while running:
        height, width = stdscr.getmaxyx()
        if height < MIN_HEIGHT or width < MIN_WIDTH:
            stdscr.erase()
            msg = ("Terminal too small. Need at least %dx%d, got %dx%d.\n"
                   "Resize your terminal and run again." % (MIN_WIDTH, MIN_HEIGHT,
                                                            width, height))
            lines = msg.split("\n")
            for i, line in enumerate(lines):
                stdscr.addstr(height // 2 - len(lines) // 2 + i,
                              max(2, (width - len(line)) // 2), line)
            stdscr.refresh()
            # Wait for the user to acknowledge, then restart.
            stdscr.nodelay(False)
            stdscr.getch()
            stdscr.nodelay(True)
            # Keep the existing state; the loop will redraw once big enough.
            continue

        # Non-blocking input so the ball keeps moving.
        stdscr.nodelay(True)
        prev_char = stdscr.instr(state.ball_row, state.ball_col) if \
            (0 <= state.ball_row < height and 0 <= state.ball_col < width) else b""
        # Drain any pending input without blocking.
        try:
            key = stdscr.getch()
        except curses.error:
            key = -1

        if key != -1 and key != curses.ERR:
            # Re-inject by handling directly.
            if key in (ord("q"), ord("Q"), 3):
                running = False
                continue
            if state.status in ("won", "game_over"):
                state.reset(full=True)
                continue
            if key in (curses.KEY_LEFT, ord("a"), ord("A")):
                state.move_paddle(-2)
            elif key in (curses.KEY_RIGHT, ord("d"), ord("D")):
                state.move_paddle(2)
            elif key in (ord("r"), ord("R")):
                state.reset(full=True)
            elif key in (ord(" "), 10, 13):
                if state.serving:
                    state.serving = False

        # Physics tick.
        if state.status == "playing":
            state.update()

        render(stdscr, state)

        # If in a terminal state, pause and wait for input.
        if state.status in ("won", "game_over"):
            stdscr.nodelay(False)
            state.update()  # no-op, just to drain nothing
            render(stdscr, state)
            # Block for a single keystroke to restart or quit.
            key = stdscr.getch()
            if key in (ord("q"), ord("Q"), 3):
                running = False
                continue
            state.reset(full=True)


def run():
    """Entry point: run the game under curses, always restoring the terminal."""
    try:
        curses.wrapper(main)
    except KeyboardInterrupt:
        # curses.wrapper already restores the terminal; nothing more to do.
        pass
    except Exception as exc:  # pragma: no cover - defensive
        # curses.wrapper restores the terminal on any exception.
        sys.stderr.write("Game error: %s\n" % exc)
        sys.exit(1)


if __name__ == "__main__":
    run()
