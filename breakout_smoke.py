#!/usr/bin/env python3
"""Breakout / Arkanoid clone drawn entirely with text characters using curses.

A self-contained, dependency-free terminal game. Run with:

    python3 breakout_smoke.py

Controls:
  Left / Right arrow keys or 'a' / 'd'  -> move paddle
  Space                                -> (re)launch ball / serve
  'q' or ESC                           -> quit

Terminal state is restored via curses.wrapper even on exceptions/interrupts.
Handles terminals that are too small by displaying a useful message.
"""

import curses
import random
import time

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MIN_LINES = 24
MIN_COLS = 80

PADDLE_WIDTH = 9
PADDLE_CHAR = "="
PADDLE_MOVE = 2

BRICK_ROWS = 6
BRICK_COLS = 14
BRICK_WIDTH = 5
BRICK_HEIGHT = 2
BRICK_GAP = 1
BRICK_TOP = 4
BRICK_LEFT = (80 - (BRICK_COLS * BRICK_WIDTH + (BRICK_COLS - 1) * BRICK_GAP)) // 2

BRICK_CHARS = ["#", "%", "@", "*", "+", "x"]

MAX_LIVES = 3
SERVE_SPEED_X = 3.0
SERVE_SPEED_Y = -2.0

BALL_CHAR = "O"
WALL_CHAR = "|"
CEILING_CHAR = "-"

TICK_INTERVAL = 0.02  # seconds between ball movement updates

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class Ball:
    def __init__(self, x, y, dx=0.0, dy=0.0):
        self.x = float(x)
        self.y = float(y)
        self.dx = float(dx)
        self.dy = float(dy)

    def reset(self, x, y):
        self.x = float(x)
        self.y = float(y)
        self.dx = 0.0
        self.dy = 0.0

    def serve(self):
        angle = random.uniform(-0.4, 0.4)
        self.dx = abs(SERVE_SPEED_X * (0.5 + angle))
        if random.random() < 0.5:
            self.dx = -self.dx
        self.dy = SERVE_SPEED_Y

    def move(self):
        self.x += self.dx
        self.y += self.dy


class Paddle:
    def __init__(self, x, width, max_x):
        self.x = float(x)
        self.width = width
        self.max_x = float(max_x)

    def move(self, delta):
        self.x = max(0.0, min(self.max_x - self.width, self.x + delta))

    @property
    def center(self):
        return self.x + self.width / 2.0

    @property
    def right(self):
        return self.x + self.width


class Brick:
    def __init__(self, x, y, w, h, row_index):
        self.x = x
        self.y = y
        self.w = w
        self.h = h
        self.row_index = row_index
        self.destroyed = False

    def hit(self):
        if not self.destroyed:
            self.destroyed = True
            return True
        return False


class GameState:
    RUNNING = "running"
    PAUSED = "paused"
    WON = "won"
    GAME_OVER = "game_over"


# ---------------------------------------------------------------------------
# Game
# ---------------------------------------------------------------------------


def build_bricks(cols, rows):
    bricks = []
    for r in range(rows):
        for c in range(cols):
            bx = BRICK_LEFT + c * (BRICK_WIDTH + BRICK_GAP)
            by = BRICK_TOP + r * BRICK_HEIGHT
            bricks.append(Brick(bx, by, BRICK_WIDTH, BRICK_HEIGHT, r))
    return bricks


class Game:
    def __init__(self, stdscr):
        self.stdscr = stdscr
        self.max_y = 0
        self.max_x = 0
        self.paddle = None
        self.ball = None
        self.bricks = []
        self.score = 0
        self.lives = MAX_LIVES
        self.state = GameState.PAUSED
        self.status_msg = "Press SPACE to serve. Arrow keys / a-d to move."
        self._setup_sizes()

    def _setup_sizes(self):
        self.max_y, self.max_x = self.stdscr.getmaxyx()
        paddle_max_x = self.max_x - PADDLE_WIDTH
        self.paddle = Paddle((self.max_x - PADDLE_WIDTH) / 2.0, PADDLE_WIDTH, paddle_max_x)
        self.ball = Ball(self.paddle.center, self.max_y - 3)
        self.bricks = build_bricks(BRICK_COLS, BRICK_ROWS)

    def reset_round(self):
        if self.paddle is None:
            self._setup_sizes()
        self.paddle.x = (self.max_x - PADDLE_WIDTH) / 2.0
        self.ball.reset(self.paddle.center, self.max_y - 3)
        self.ball_served = False
        self.status_msg = "Press SPACE to serve. Arrow keys / a-d to move."
        self.state = GameState.PAUSED

    def reset_full(self):
        self._setup_sizes()
        self.score = 0
        self.lives = MAX_LIVES
        self.reset_round()

    # -- physics ----------------------------------------------------------

    def reflect_ball_walls(self):
        x, y = self.ball.x, self.ball.y
        if x <= 0:
            self.ball.x = 0.0
            self.ball.dx = abs(self.ball.dx)
        elif x >= self.max_x - 1:
            self.ball.x = float(self.max_x - 1)
            self.ball.dx = -abs(self.ball.dx)
        if y <= 0:
            self.ball.y = 1.0
            self.ball.dy = abs(self.ball.dy)

    def brick_collision(self):
        cx, cy = int(round(self.ball.x)), int(round(self.ball.y))
        for brick in self.bricks:
            if brick.destroyed:
                continue
            if brick.x <= cx < brick.x + brick.w and brick.y <= cy < brick.y + brick.h:
                if brick.hit():
                    self.score += 10
                    self._reflect_off_brick(brick)
                    return True
        return False

    def _reflect_off_brick(self, brick):
        x, y = self.ball.x, self.ball.y
        bx_center = brick.x + brick.w / 2.0
        by_center = brick.y + brick.h / 2.0
        dx = (x - bx_center) / (brick.w / 2.0) if brick.w else 1.0
        dy = (y - by_center) / (brick.h / 2.0) if brick.h else 1.0
        if abs(dx) > abs(dy):
            if dx > 0:
                self.ball.dx = abs(self.ball.dx)
                self.ball.x = float(brick.x + brick.w)
            else:
                self.ball.dx = -abs(self.ball.dx)
                self.ball.x = float(brick.x - 1)
        else:
            if dy > 0:
                self.ball.dy = abs(self.ball.dy)
                self.ball.y = float(brick.y + brick.h)
            else:
                self.ball.dy = -abs(self.ball.dy)
                self.ball.y = float(brick.y - 1)
        self.ball.dx *= 0.98
        self.ball.dy *= 0.98

    def paddle_collision(self):
        x, y = self.ball.x, self.ball.y
        py = self.max_y - 3
        # Paddle occupies y in [py-1, py+1] region; ball near paddle bottom
        if y >= py - 1 and y <= py + 1 and self.paddle.x <= x < self.paddle.right:
            # Reflect based on where ball hit on paddle
            rel = (x - self.paddle.x) / self.paddle.width  # 0.0 left .. 1.0 right
            if rel < 0.33:
                self.ball.dx = -abs(self.ball.dx)
            elif rel > 0.66:
                self.ball.dx = abs(self.ball.dx)
            else:
                self.ball.dx = abs(self.ball.dx) if self.ball.dx >= 0 else -abs(self.ball.dx)
                if abs(self.ball.dx) < 0.5:
                    self.ball.dx = SERVE_SPEED_X * 0.5
            self.ball.dy = -abs(self.ball.dy)
            self.ball.y = float(py - 2)
            return True
        return False

    def check_lost(self):
        # Ball fell below the bottom of the screen
        if self.ball.y >= self.max_y:
            return True
        return False

    def check_won(self):
        return all(b.destroyed for b in self.bricks)

    def update(self):
        if self.state == GameState.RUNNING and self.ball_served:
            self.ball.move()
            self.reflect_ball_walls()
            if not self.brick_collision():
                self.paddle_collision()
            if self.check_lost():
                self.lives -= 1
                if self.lives <= 0:
                    self.state = GameState.GAME_OVER
                    self.status_msg = "GAME OVER — Press R to restart, Q to quit."
                else:
                    self.state = GameState.PAUSED
                    self.status_msg = (
                        "Lost a life! Press SPACE to serve. Lives: %d" % self.lives
                    )
            elif self.check_won():
                self.state = GameState.WON
                self.status_msg = "YOU WIN! Press R to restart, Q to quit."

    # -- input ------------------------------------------------------------

    def handle_key(self, ch):
        if ch is None:
            return
        if ch in (ord("q"), ord("Q"), 27):
            self.state = "quit"
            return
        if self.state in (GameState.WON, GameState.GAME_OVER, GameState.PAUSED):
            if ch in (ord("r"), ord("R")):
                if self.state == GameState.GAME_OVER or self.state == GameState.WON:
                    self.score = 0
                    self.lives = MAX_LIVES
                    self._setup_sizes()
                    self.reset_round()
                else:
                    self.reset_round()
                return
        if self.state in (GameState.PAUSED,):
            if ch == ord(" "):
                self.ball_served = True
                self.ball.serve()
                self.state = GameState.RUNNING
                self.status_msg = "Score: %d  Lives: %d" % (self.score, self.lives)
                return
            return
        if self.state == GameState.RUNNING:
            if ch == ord(" "):
                if not self.ball_served:
                    self.ball_served = True
                    self.ball.serve()
                return
            if ch in (curses.KEY_LEFT, ord("a"), ord("A")):
                self.paddle.move(-PADDLE_MOVE)
            elif ch in (curses.KEY_RIGHT, ord("d"), ord("D")):
                self.paddle.move(PADDLE_MOVE)

    # -- rendering --------------------------------------------------------

    def draw(self):
        stdscr = self.stdscr
        stdscr.erase()
        max_y, max_x = self.max_y, self.max_x

        # Border
        for x in range(max_x - 1):
            stdscr.addch(0, x, CEILING_CHAR)
        for y in range(1, max_y - 1):
            try:
                stdscr.addch(y, 0, WALL_CHAR)
                stdscr.addch(y, max_x - 1, WALL_CHAR)
            except curses.error:
                pass
        for x in range(max_x - 1):
            stdscr.addch(max_y - 1, x, WALL_CHAR)

        # Bricks
        for brick in self.bricks:
            if brick.destroyed:
                continue
            ch = BRICK_CHARS[min(brick.row_index, len(BRICK_CHARS) - 1)]
            for by in range(brick.y, brick.y + brick.h):
                for bx in range(brick.x, brick.x + brick.w):
                    if 0 < by < max_y - 1 and 0 < bx < max_x - 1:
                        try:
                            stdscr.addch(by, bx, ch)
                        except curses.error:
                            pass

        # Paddle
        py = max_y - 3
        for px in range(int(self.paddle.x), int(self.paddle.x + self.paddle.width)):
            if 0 < py < max_y - 1 and 0 < px < max_x - 1:
                try:
                    stdscr.addch(py, px, PADDLE_CHAR)
                except curses.error:
                    pass

        # Ball
        bx, by = int(round(self.ball.x)), int(round(self.ball.y))
        if 0 < by < max_y - 1 and 0 < bx < max_x - 1:
            try:
                stdscr.addch(by, bx, BALL_CHAR)
            except curses.error:
                pass

        # HUD: score and lives
        hud = "Score: %d  Lives: %d/%d" % (self.score, self.lives, MAX_LIVES)
        try:
            stdscr.addch(1, 2, hud[:max_x - 3].encode("utf-8", "ignore").decode())
        except curses.error:
            pass

        # Status / state message
        if self.state in (GameState.WON, GameState.GAME_OVER, GameState.PAUSED):
            msg = self.status_msg
        else:
            msg = "Score: %d  Lives: %d/%d" % (self.score, self.lives, MAX_LIVES)
        if msg:
            try:
                stdscr.addch(max_y - 2, 2, msg[:max_x - 3].encode("utf-8", "ignore").decode())
            except curses.error:
                pass

        stdscr.refresh()


def run(stdscr):
    # Initialize curses
    curses.curs_set(0)
    stdscr.nodelay(False)
    stdscr.keypad(True)
    curses.noecho()
    curses.cbreak()
    try:
        stdscr.timeout(100)

        # Terminal-size guard
        max_y, max_x = stdscr.getmaxyx()
        if max_y < MIN_LINES or max_x < MIN_COLS:
            stdscr.erase()
            msg1 = "Terminal too small!"
            msg2 = "Need at least %dx%d, but have %dx%d." % (
                MIN_COLS, MIN_LINES, max_x, max_y)
            msg3 = "Resize your terminal and run again."
            for i, msg in enumerate([msg1, msg2, msg3]):
                try:
                    stdscr.addstr(max_y // 2 - 1 + i, max((max_x - len(msg)) // 2, 0), msg)
                except curses.error:
                    pass
            stdscr.refresh()
            # Wait for a keypress, then exit cleanly
            stdscr.timeout(-1)
            try:
                stdscr.getch()
            except Exception:
                pass
            return

        game = Game(stdscr)

        last_tick = time.monotonic()
        while game.state != "quit":
            try:
                ch = stdscr.getch()
            except curses.error:
                ch = None
            if ch != -1 and ch is not None:
                game.handle_key(ch)
            now = time.monotonic()
            if now - last_tick >= TICK_INTERVAL:
                game.update()
                last_tick = now
            game.draw()
            # If paused (serve) or game ended, briefly block for input clarity
            if game.state in (GameState.PAUSED, GameState.WON, GameState.GAME_OVER):
                stdscr.nodelay(False)
                stdscr.timeout(200)
                try:
                    extra = stdscr.getch()
                except curses.error:
                    extra = -1
                if extra != -1 and extra is not None:
                    game.handle_key(extra)
                    # Drain any additional buffered keys
                    while True:
                        try:
                            more = stdscr.getch()
                        except curses.error:
                            more = -1
                        if more == -1 or more is None:
                            break
                        game.handle_key(more)
                stdscr.nodelay(True)
                stdscr.timeout(100)
            else:
                # Small sleep to keep the loop from spinning too fast
                time.sleep(0.005)
    finally:
        # Ensure terminal state is restored
        curses.nocbreak()
        stdscr.keypad(False)
        curses.echo()
        curses.curs_set(1)


def main():
    try:
        curses.wrapper(run)
    except KeyboardInterrupt:
        pass
    except curses.error as exc:
        # Report infrastructure-blocked validation honestly to stderr
        import sys
        sys.stderr.write("curses error: %s\n" % exc)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
