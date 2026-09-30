#!/usr/bin/env python3
"""Arkanoid (Breakout) in pure-Python curses.

A single self-contained file: classic Arkanoid gameplay drawn entirely with
text characters. Runs in an Ubuntu terminal using only the standard library.
"""

import curses
import sys

# --- Layout constants --------------------------------------------------------
MIN_WIDTH = 40
MIN_HEIGHT = 18

PADDLE_W = 8
PADDLE_CH = "#"

# Brick layout
BRICK_ROWS = 6
BRICK_COLS = 12
BRICK_CHARS = ["@", "+", "*", "&"]

# Input timing
FRAME_TIMEOUT = 50  # ms per frame (~20 fps)

# States
PLAY = "play"
END = "end"


def _clamp_paddle_x(position, play_w):
    """Clamp a paddle x position to the playable area.

    Preserves the original clamp semantics, including narrow board widths
    where play_w - PADDLE_W may be negative (the paddle is then pinned to 0).
    """
    return max(0, min(play_w - PADDLE_W, position))


class Game:
    def __init__(self, stdscr, width, height):
        self.stdscr = stdscr
        self.width = width
        self.height = height
        self.play_w = width - 2
        self._resize(width, height)
        self.reset()

    def _resize(self, width, height):
        self.width = width
        self.height = height
        self.play_w = width - 2
        self.pad_y = height - 4  # paddle row
        self.bottom_fill_y = height - 3  # separator line row
        self.status_y = height - 2  # status line row

    def reset(self):
        self.score = 0
        self.lives = 3
        self.bricks = self._build_bricks()
        self.paddle_x = max(0, self.play_w // 2 - PADDLE_W // 2)
        self._serve()

    def _build_bricks(self):
        bricks = []
        brick_w = max(1, self.play_w // BRICK_COLS)
        for r in range(BRICK_ROWS):
            for c in range(BRICK_COLS):
                bricks.append(
                    {
                        "x": 1 + c * brick_w,
                        "y": 1 + r,
                        "w": brick_w,
                        "row": r,
                        "points": 10 * (BRICK_ROWS - r),
                    }
                )
        return bricks

    def _serve(self):
        self.ball_x = float(self.paddle_x + PADDLE_W // 2)
        self.ball_y = float(self.pad_y)
        self.ball_dx = 0.0
        self.ball_dy = 0.0
        self.serving = True

    # --- input ---------------------------------------------------------------
    def _move_paddle(self, delta):
        self.paddle_x = _clamp_paddle_x(self.paddle_x + delta, self.play_w)

    def handle_key(self, key):
        """Process a key. Returns False if the program should quit."""
        if key in (ord("q"), ord("Q")):
            return False
        if self.serving:
            if key in (curses.KEY_LEFT, ord("a"), ord("A")):
                self._move_paddle(-1)
            elif key in (curses.KEY_RIGHT, ord("d"), ord("D")):
                self._move_paddle(1)
            elif key == ord(" "):
                self.ball_dx = 1.0
                self.ball_dy = -1.0
                self.serving = False
            return True
        if key in (curses.KEY_LEFT, ord("a"), ord("A")):
            self._move_paddle(-1)
        elif key in (curses.KEY_RIGHT, ord("d"), ord("D")):
            self._move_paddle(1)
        return True

    # --- physics -------------------------------------------------------------
    def update(self):
        """Returns PLAY or END."""
        if self.serving:
            # ball tracks paddle center while serving
            self.ball_y = float(self.pad_y)
            self.ball_x = float(self.paddle_x + PADDLE_W // 2)
            return PLAY

        nx = self.ball_x + self.ball_dx
        ny = self.ball_y + self.ball_dy

        # Left / right walls
        if nx <= 0:
            nx = 1.0
            self.ball_dx = -self.ball_dx
        elif nx >= self.play_w:
            nx = self.play_w - 1.0
            self.ball_dx = -self.ball_dx

        # Top wall
        if ny <= 0:
            ny = 1.0
            self.ball_dy = -self.ball_dy

        # Bottom: lose a life
        if ny >= self.status_y:
            self.lives -= 1
            if self.lives <= 0:
                return END
            self._serve()
            return PLAY

        # Brick collision
        brick = self._hit_brick(nx, ny)
        if brick:
            self.bricks.remove(brick)
            self.score += brick["points"]
            if self.ball_dy > 0:
                # hit from below -> bounce up
                self.ball_dy = -abs(self.ball_dy)
                ny = brick["y"] - 1
            else:
                # hit from above -> bounce down
                self.ball_dy = abs(self.ball_dy)
                ny = brick["y"] + 2

        # Paddle collision
        if (
            self.ball_dy > 0
            and self.pad_y - 1 <= ny <= self.pad_y + 1
            and self.paddle_x <= nx <= self.paddle_x + PADDLE_W
        ):
            self.ball_dy = -abs(self.ball_dy)
            ny = self.pad_y - 1
            # angle depends on where it struck the paddle
            offset = (nx - self.paddle_x) / PADDLE_W - 0.5
            self.ball_dx = self.ball_dx + offset * 1.5
            if abs(self.ball_dx) < 0.6:
                self.ball_dx = 1.0 if offset >= 0 else -1.0

        # Keep a sane horizontal speed
        if abs(self.ball_dx) > 3.0:
            self.ball_dx = 3.0 if self.ball_dx > 0 else -3.0

        self.ball_x = nx
        self.ball_y = ny

        if not self.bricks:
            return END  # win (no bricks left)

        return PLAY

    def _hit_brick(self, x, y):
        for brick in self.bricks:
            if (
                brick["x"] <= x < brick["x"] + brick["w"]
                and brick["y"] <= y <= brick["y"] + 1
            ):
                return brick
        return None

    # --- rendering -----------------------------------------------------------
    def draw(self):
        self.stdscr.erase()
        self.stdscr.box()
        # bricks
        for brick in self.bricks:
            ch = BRICK_CHARS[brick["row"] % len(BRICK_CHARS)]
            for i in range(brick["w"]):
                self._put(brick["y"], brick["x"] + i, ch)
        # separator line
        self._put(self.bottom_fill_y, 1, "=" * (self.play_w))
        # paddle
        self._put(self.pad_y, self.paddle_x, PADDLE_CH * PADDLE_W)
        # ball
        self._put(int(self.ball_y), int(self.ball_x), "O")
        # status line
        status = f" Arkanoid  SCORE: {self.score:<6}  LIVES: {self.lives} "
        self._put(self.status_y, 1, status[: self.play_w].ljust(self.play_w))
        if self.serving:
            self._put(self.status_y, (self.play_w - 18) // 2, "PRESS SPACE TO SERVE")
        self.stdscr.refresh()

    def draw_message(self, title, subtitle):
        self.draw()
        box_w = 40
        box_h = 9
        x0 = max(1, (self.width - box_w) // 2)
        y0 = max(1, (self.height - box_h) // 2)
        # box frame
        for x in range(x0 + 1, x0 + box_w - 1):
            self._put(y0, x, curses.ACS_HLINE)
            self._put(y0 + box_h, x, curses.ACS_HLINE)
        for y in range(y0 + 1, y0 + box_h):
            self._put(y, x0, curses.ACS_VLINE)
            self._put(y, x0 + box_w - 1, curses.ACS_VLINE)
        self._put(y0, x0, curses.ACS_ULCORNER)
        self._put(y0, x0 + box_w - 1, curses.ACS_URCORNER)
        self._put(y0 + box_h, x0, curses.ACS_LLCORNER)
        self._put(y0 + box_h, x0 + box_w - 1, curses.ACS_LRCORNER)
        self._put(y0 + 2, x0 + 1, title.center(box_w - 2))
        self._put(y0 + 4, x0 + 1, subtitle.center(box_w - 2))
        self.stdscr.refresh()

    def _put(self, y, x, text):
        if y < 0 or y >= self.height or x < 0:
            return
        for i, ch in enumerate(str(text)):
            if 0 <= x + i < self.width:
                try:
                    self.stdscr.addch(y, x + i, ch)
                except curses.error:
                    pass


def check_size(stdscr):
    height, width = stdscr.getmaxyx()
    if width < MIN_WIDTH or height < MIN_HEIGHT:
        stdscr.erase()
        msg = (
            f"Terminal too small. Need at least {MIN_WIDTH} columns x "
            f"{MIN_HEIGHT} rows. Current: {width} x {height}."
        )
        try:
            stdscr.addstr(0, 0, msg)
        except curses.error:
            pass
        stdscr.refresh()
        stdscr.nodelay(False)
        stdscr.getch()
        return False
    return True


def run(stdscr):
    stdscr.keypad(True)
    stdscr.timeout(FRAME_TIMEOUT)
    try:
        curses.curs_set(0)
    except curses.error:
        pass

    if not check_size(stdscr):
        return

    height, width = stdscr.getmaxyx()
    game = Game(stdscr, width, height)
    state = PLAY

    while True:
        try:
            key = stdscr.getch()
        except curses.error:
            key = -1

        if key == curses.KEY_RESIZE:
            if not check_size(stdscr):
                break
            height, width = stdscr.getmaxyx()
            game._resize(width, height)
            # reposition ball if not mid-flight
            if game.serving:
                game._serve()
            game.draw()
            continue

        if state == END:
            if key in (ord("q"), ord("Q")):
                break
            if key in (ord("r"), ord("R"), curses.KEY_ENTER, 10, 13):
                game.reset()
                state = PLAY
            continue

        if not game.handle_key(key):
            break

        result = game.update()
        if result == END:
            state = END
            if game.lives <= 0:
                game.draw_message(
                    "GAME OVER",
                    f"Final score: {game.score}   r=restart  q=quit",
                )
            else:
                game.draw_message(
                    "YOU WIN!",
                    f"Score: {game.score}   r=restart  q=quit",
                )
            continue
        game.draw()


def main():
    try:
        curses.wrapper(run)
    except KeyboardInterrupt:
        pass
    except Exception as exc:  # pragma: no cover - safety net
        print(f"Arkanoid terminated: {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
