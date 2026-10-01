#!/usr/bin/env python3
"""escape_breakout_smoke.py - curses Breakout game. Stdlib only."""
import curses
import random
import sys

HELP_TEXT = "Controls:\n  Left/Right or A/D: move paddle\n  R: restart  Q: quit"
STATUS_SEPARATOR = "\t|\t"

PADDLE = "="
BALL = "O"
BRICK = "#"
EMPTY = " "
BH, BV, CORNER = "-", "|", "+"

FW, FH = 60, 20
BRICK_ROWS, BRICK_COLS = 6, 12
BRICK_W = 4
PADDLE_W = 10
LIVES = 3
PTS = 10
MIN_W = FW + 10
MIN_H = FH + 8


def make_bricks():
    return [{"x": 2 + c * BRICK_W, "y": 2 + r, "c": BRICK}
            for r in range(BRICK_ROWS) for c in range(BRICK_COLS)]


class Game:
    def __init__(self):
        self.w, self.h = FW, FH
        self.px = self.w // 2 - PADDLE_W // 2
        self.bx = float(self.px + PADDLE_W // 2)
        self.by = float(self.h - 4)
        self.dx = 1.0
        self.dy = -1.0
        self.dir = -1.0
        self.score = 0
        self.lives = LIVES
        self.state = "playing"
        self.bricks = make_bricks()

    def status_parts(self):
        return ("Score:%d" % self.score, "Lives:%d" % self.lives,
                "State:%s" % self.state)

    def status_line(self):
        return STATUS_SEPARATOR.join(self.status_parts()).replace("\t", "   ")

    def move(self, d):
        if self.state != "playing":
            return
        self.px = max(0, min(self.px + d, self.w - PADDLE_W))

    def serve(self):
        self.bx = float(self.px + PADDLE_W // 2)
        self.by = float(self.h - 4)
        self.dx = self.dir * random.choice([0.5, 0.7, 1.0])
        self.dy = -1.0
        self.dir = -self.dir

    def restart(self):
        self.px = self.w // 2 - PADDLE_W // 2
        self.score = 0
        self.lives = LIVES
        self.state = "playing"
        self.bricks = make_bricks()
        self.dir = -1.0
        self.serve()

    def _hit_brick(self):
        for b in self.bricks:
            if (abs(b["x"] - int(self.bx)) < BRICK_W
                    and abs(b["y"] - int(self.by)) < 1):
                self.bricks.remove(b)
                self.score += PTS
                self.dy = -self.dy
                return True
        return False

    def update(self):
        if self.state != "playing":
            return
        self.bx += self.dx
        self.by += self.dy
        if self.by <= 1:
            self.by = 1.0
            self.dy = abs(self.dy)
        if self.bx <= 0:
            self.bx = 0.0
            self.dx = abs(self.dx)
        elif self.bx >= self.w - 1:
            self.bx = float(self.w - 1)
            self.dx = -abs(self.dx)
        self._hit_brick()
        if int(self.by) >= self.h - 4:
            if self.px <= int(self.bx) < self.px + PADDLE_W:
                self.by = float(self.h - 4)
                self.dy = -abs(self.dy)
                rel = (self.bx - self.px) / PADDLE_W - 0.5
                self.dx = rel * 3.0
        if int(self.by) >= self.h - 2:
            self.lives -= 1
            if self.lives <= 0:
                self.state = "game over"
            else:
                self.serve()
        if not self.bricks and self.state == "playing":
            self.state = "won"

    def draw(self, win):
        win.erase()
        for x in range(self.w + 1):
            win.addch(0, x, BH)
            win.addch(self.h, x, BH)
        for y in range(self.h + 1):
            win.addch(y, 0, BV)
            win.addch(y, self.w, BV)
        win.addch(0, 0, CORNER)
        win.addch(0, self.w, CORNER)
        win.addch(self.h, 0, CORNER)
        win.addch(self.h, self.w, CORNER)
        for b in self.bricks:
            win.addch(b["y"], b["x"], b["c"])
        for x in range(self.px, self.px + PADDLE_W):
            win.addch(self.h - 3, x, PADDLE)
        win.addch(int(self.by), int(self.bx), BALL)
        # Status line
        win.addch(self.h + 2, 1, self.status_line()[:self.w - 1])
        # Help text
        lines = HELP_TEXT.split("\n")
        for i, line in enumerate(lines):
            win.addch(self.h + 4 + i, 1, line[:self.w - 1])
        # Game over / win overlay
        if self.state == "won":
            msg = "YOU WIN!  Press R to restart or Q to quit."
            win.addstr(1, 2, msg)
        if self.state == "game over":
            msg = "GAME OVER  Press R to restart or Q to quit."
            win.addstr(1, 2, msg)

def draw_small_screen(win, width, height):
    win.erase()
    msg = "Terminal too small!"
    msg2 = ("Need at least %dx%d, got %dx%d" % (MIN_W, MIN_H, width, height))
    msg3 = "Resize and press any key to try again, or Q to quit."
    win.addstr(1, 1, msg)
    win.addstr(2, 1, msg2)
    win.addstr(3, 1, msg3)
    win.refresh()


def run():
    curses.raw()
    curses.noecho()
    curses.cbreak()
    game = None
    try:
        win = curses.initscr()
        win.keypad(True)
        win.nodelay(True)
        curses.curs_set(0)
        while True:
            height, width = win.getmaxyx()
            if width < MIN_W or height < MIN_H:
                draw_small_screen(win, width, height)
                win.nap(100)
                try:
                    ch = win.getch()
                except Exception:
                    ch = -1
                if ch in (ord('q'), ord('Q'), 27):
                    break
                if ch != -1:
                    h2, w2 = win.getmaxyx()
                    if w2 >= MIN_W and h2 >= MIN_H:
                        game = Game()
                        win.nodelay(True)
                continue
            if game is None:
                game = Game()
            game.update()
            game.draw(win)
            win.refresh()
            win.nap(50)
            try:
                ch = win.getch()
            except Exception:
                ch = -1
            if ch in (ord('q'), ord('Q')): 
                break
            if ch == ord('r') or ch == ord('R'):
                game.restart()
            paddle_speed = getattr(game, 'paddle_speed', 2)
            if ch in (curses.KEY_LEFT, ord('a'), ord('A')):
                game.move(-paddle_speed)
            if ch in (curses.KEY_RIGHT, ord('d'), ord('D')):
                game.move(paddle_speed)
            if ch == ord('p') or ch == ord('P'):
                if game.state == "playing":
                    game.state = "paused"
                elif game.state == "paused":
                    game.state = "playing"
    finally:
        try:
            curses.nocbreak()
            curses.echo()
            curses.endwin()
        except Exception:
            pass


def main():
    try:
        run()
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        # Best-effort terminal restore before printing.
        try:
            curses.endwin()
        except Exception:
            pass
        sys.stderr.write("Error: %s\n" % exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
</arg_value></tool_call><tool_call>structured_output<arg_key>value</arg_key><arg_value>{