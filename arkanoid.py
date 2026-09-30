#!/usr/bin/env python3
"""Arkanoid (Breakout) game drawn with text characters using the curses module.

Run with: python3 arkanoid.py

Controls:
  Left / Right arrow keys (or 'a' / 'd')  move the paddle
  'q' or ESC                               quit
"""

import curses
import random
import time

# Game parameters
PADDLE_WIDTH = 9
BALL_SYMBOL = "O"
PADDLE_SYMBOL = "="
BRICK_SYMBOLS = ["#", "@", "%"]
FRAME_TIME = 0.04  # seconds between frames (~25 FPS)

# Number of lives at the start of the game.
STARTING_LIVES = 3


def build_level(rows, cols):
    """Build the initial brick layout.

    Bricks are stored as a list of dicts: {y, x, width, symbol, color}.
    Rows of bricks are placed near the top of the playfield.
    """
    bricks = []
    # Reserve the top rows for bricks, below the score banner.
    top = 3
    brick_height = 2
    brick_gap = 1
    rows_of_bricks = 5
    # Fit bricks within the playable width, leaving a border margin.
    margin = 2
    usable_width = cols - 2 * margin
    brick_width = max(4, usable_width // 8)
    # Recompute so bricks tile the usable width cleanly.
    count = max(1, usable_width // (brick_width + brick_gap))
    colors = [2, 3, 4, 5, 6]
    for row in range(rows_of_bricks):
        # Offset every other row for a brick-like pattern.
        offset = margin + (row % 2) * (brick_width // 2)
        for i in range(count):
            x = offset + i * (brick_width + brick_gap)
            x = min(x, cols - 1 - brick_width)
            symbol = BRICK_SYMBOLS[row % len(BRICK_SYMBOLS)]
            bricks.append({
                "symbol": symbol,
                "y": top + row * (brick_height + brick_gap),
                "x": x,
                "width": brick_width,
                "color": colors[row % len(colors)],
            })
    return bricks


def inside(p, y, x):
    """True if (y, x) is within the playable area (excluding outer border)."""
    return 1 <= y <= p["rows"] - 2 and 1 <= x <= p["cols"] - 2


def reset_ball(p):
    """Reset the ball to the paddle for the next serve."""
    p["ball_y"] = p["paddle_y"] - 1
    p["ball_x"] = p["paddle_x"] + p["paddle_width"] // 2
    p["ball_dy"] = -1
    # Launch at an angle; pick a random horizontal direction.
    p["ball_dx"] = random.choice([-1.0, 1.0])
    p["serving"] = True


def serve_ball(p):
    """Release the ball from the serve position."""
    p["serving"] = False
    if p["ball_dy"] >= 0:
        p["ball_dy"] = -1
    # Apply a slight horizontal speed so it's not a pure vertical serve.
    if abs(p["ball_dx"]) < 0.3:
        p["ball_dx"] = random.choice([-1.0, 1.0])


def move_paddle(p, direction):
    """Move the paddle left (-1) or right (+1) within bounds."""
    delta = direction * 2
    new_x = p["paddle_x"] + delta
    max_x = p["cols"] - 1 - p["paddle_width"]
    if new_x < 1:
        new_x = 1
    if new_x > max_x:
        new_x = max_x
    p["paddle_x"] = new_x


def ball_hits_paddle(p):
    """Check whether the ball is overlapping the paddle."""
    by = round(p["ball_y"])
    bx = round(p["ball_x"])
    py = p["paddle_y"]
    px = p["paddle_x"]
    pw = p["paddle_width"]
    # Ball is at or just above the paddle top.
    if (by == py or by == py - 1) and px <= bx < px + pw:
        return True
    return False


def handle_collision(p):
    """Move the ball and resolve collisions with walls, paddle, and bricks.

    Returns one of: 'hit', 'miss', 'serve'.
    """
    rows = p["rows"]
    cols = p["cols"]
    y = p["ball_y"] + p["ball_dy"]
    x = p["ball_x"] + p["ball_dx"]

    # Top wall
    if y <= 0:
        y = 0
        p["ball_dy"] = -p["ball_dy"]
        p["ball_y"] = y
        p["ball_x"] = x
        return "hit"
    # Bottom wall: losing the ball
    if y >= rows - 1:
        p["ball_y"] = rows - 2
        p["ball_x"] = x
        return "miss"
    # Side walls
    if x <= 0:
        x = 0
        p["ball_dx"] = -p["ball_dx"]
    elif x >= cols - 1:
        x = cols - 1
        p["ball_dx"] = -p["ball_dx"]

    p["ball_y"] = y
    p["ball_x"] = x

    # Paddle collision
    if ball_hits_paddle(p):
        p["ball_y"] = p["paddle_y"] - 1
        p["ball_dy"] = -abs(p["ball_dy"])
        # Add spin based on where the ball hit the paddle.
        offset = (p["ball_x"] - p["paddle_x"]) / p["paddle_width"] - 0.5
        p["ball_dx"] += offset * 0.6
        # Clamp horizontal speed to keep it playable.
        max_speed = 1.5
        if p["ball_dx"] > max_speed:
            p["ball_dx"] = max_speed
        if p["ball_dx"] < -max_speed:
            p["ball_dx"] = -max_speed
        return "hit"

    # Brick collision
    for brick in p["bricks"]:
        by = round(p["ball_y"])
        bx = round(p["ball_x"])
        if brick["y"] <= by < brick["y"] + 2 and brick["x"] <= bx < brick["x"] + brick["width"]:
            p["bricks"].remove(brick)
            p["score"] += 10
            # Determine bounce direction based on which edge was struck.
            top = brick["y"]
            bottom = brick["y"] + 1
            left = brick["x"]
            right = brick["x"] + brick["width"] - 1
            # Distance from the ball to each edge (using the pre-collision
            # position for a cleaner normal).
            dist_top = abs(by - top)
            dist_bottom = abs(by - bottom)
            dist_left = abs(bx - left)
            dist_right = abs(bx - right)
            min_dist = min(dist_top, dist_bottom, dist_left, dist_right)
            if min_dist == dist_top:
                p["ball_dy"] = -abs(p["ball_dy"])
            elif min_dist == dist_bottom:
                p["ball_dy"] = abs(p["ball_dy"])
            elif min_dist == dist_left:
                p["ball_dx"] = -abs(p["ball_dx"])
            else:
                p["ball_dx"] = abs(p["ball_dx"])
            p["ball_dy"] = p["ball_dy"] if p["ball_dy"] != 0 else -1
            return "hit"

    return "hit"


def draw(state, stdscr):
    """Render the full game frame to the screen."""
    rows = state["rows"]
    cols = state["cols"]
    # Clear the working area only (not the borders) for stable rendering.
    for y in range(2, rows - 1):
        stdscr.addstr(y, 1, " " * (cols - 2))

    # Top border
    stdscr.addstr(0, 0, "+" + "-" * (cols - 2) + "+")
    # Bottom border
    stdscr.addstr(rows - 1, 0, "+" + "-" * (cols - 2) + "+")
    # Left and right borders
    for y in range(1, rows - 1):
        stdscr.addch(y, 0, "|")
        stdscr.addch(y, cols - 1, "|")

    # Bricks
    for brick in state["bricks"]:
        for bx in range(brick["x"], brick["x"] + brick["width"]):
            if 0 < bx < cols - 1:
                try:
                    stdscr.addch(brick["y"], bx, brick["symbol"] or BRICK_SYMBOLS[0])
                except curses.error:
                    pass

    # Paddle
    py = state["paddle_y"]
    px = state["paddle_x"]
    for i in range(state["paddle_width"]):
        try:
            stdscr.addch(py, px + i, PADDLE_SYMBOL)
        except curses.error:
            pass

    # Ball
    try:
        stdscr.addch(round(state["ball_y"]), round(state["ball_x"]), BALL_SYMBOL, curses.A_BOLD)
    except curses.error:
        pass

    # Status line
    status = "Playing" if state["status"] == "playing" else state["status"].upper()
    score_text = f" SCORE: {state['score']} "
    lives_text = f" LIVES: {state['lives']} "
    status_text = f" STATUS: {status} "
    line = score_text + lives_text + status_text
    if len(line) < cols:
        line = line.ljust(cols)
    else:
        line = line[:cols]
    stdscr.addstr(1, 1, line)

    stdscr.refresh()


def show_message(state, stdscr, message):
    """Draw a centered message overlay on top of the current frame."""
    rows = state["rows"]
    cols = state["cols"]
    # Darken the playfield with a border box.
    for y in range(4, rows - 2):
        for x in range(2, cols - 2):
            try:
                stdscr.addch(y, x, " ")
            except curses.error:
                pass
    msg = f" {message} "
    box_width = max(len(msg) + 4, 20)
    start_y = rows // 2 - 3
    start_x = (cols - box_width) // 2
    stdscr.addstr(start_y, start_x, "+" + "-" * (box_width - 2) + "+")
    stdscr.addstr(start_y + 1, start_x, "|" + " " * (box_width - 2) + "|")
    stdscr.addstr(start_y + 2, start_x, "|" + msg.center(box_width - 2) + "|")
    stdscr.addstr(start_y + 3, start_x, "|" + " " * (box_width - 2) + "|")
    hint = "Press 'q' to quit"
    stdscr.addstr(start_y + 4, start_x, "|" + hint.center(box_width - 2) + "|")
    stdscr.addstr(start_y + 5, start_x, "+" + "-" * (box_width - 2) + "+")
    stdscr.refresh()


def main(stdscr):
    # Initialize curses once. curses.wrapper handles final restoration, but
    # we also set up curses features here.
    curses.curs_set(0)
    stdscr.keypad(True)
    stdscr.nodelay(True)
    stdscr.timeout(0)

    # Minimum terminal size guard.
    MIN_ROWS = 20
    MIN_COLS = 60

    rows, cols = stdscr.getmaxyx()

    def too_small():
        return rows < MIN_ROWS or cols < MIN_COLS

    if too_small():
        stdscr.clear()
        msg = "Terminal too small for Arkanoid."
        msg2 = f"Need at least {MIN_COLS} columns x {MIN_ROWS} rows."
        msg3 = f"Current: {cols} x {rows}."
        stdscr.addstr(0, 0, msg)
        stdscr.addstr(1, 0, msg2)
        stdscr.addstr(2, 0, msg3)
        stdscr.addstr(4, 0, "Resize your terminal and run again, or press any key to exit.")
        stdscr.refresh()
        # Wait briefly for a key press or timeout.
        stdscr.nodelay(False)
        try:
            stdscr.getch()
        except Exception:
            pass
        return

    # Initialize color pairs (best effort; monochrome fallback works too).
    try:
        curses.start_color()
        color_defs = [
            (1, curses.COLOR_YELLOW),
            (2, curses.COLOR_RED),
            (3, curses.COLOR_GREEN),
            (4, curses.COLOR_BLUE),
            (5, curses.COLOR_MAGENTA),
            (6, curses.COLOR_CYAN),
        ]
        for idx, color in color_defs:
            try:
                curses.init_pair(idx, color, -1)
            except Exception:
                pass
    except Exception:
        pass

    # Game state
    state = {
        "rows": rows,
        "cols": cols,
        "paddle_width": PADDLE_WIDTH,
        "paddle_y": rows - 3,
        "paddle_x": cols // 2 - PADDLE_WIDTH // 2,
        "ball_y": rows - 4,
        "ball_x": cols // 2,
        "ball_dy": -1,
        "ball_dx": 1.0,
        "bricks": build_level(rows, cols),
        "score": 0,
        "lives": STARTING_LIVES,
        "status": "playing",
        "serving": True,
    }

    # Initial serve.
    reset_ball(state)

    while True:
        # Handle resize events.
        try:
            new_rows, new_cols = stdscr.getmaxyx()
        except Exception:
            new_rows, new_cols = rows, cols
        if new_rows != rows or new_cols != cols:
            rows, cols = new_rows, new_cols
            state["rows"] = rows
            state["cols"] = cols
            if rows < MIN_ROWS or cols < MIN_COLS:
                stdscr.clear()
                stdscr.addstr(0, 0, f"Terminal too small. Need {MIN_COLS}x{MIN_ROWS}, have {cols}x{rows}.")
                stdscr.addstr(2, 0, "Resize and press any key, or 'q' to quit.")
                stdscr.refresh()
                stdscr.nodelay(False)
                try:
                    stdscr.getch()
                except Exception:
                    pass
                return
            # Rebuild level on resize to keep proportions.
            state["paddle_y"] = rows - 3
            state["bricks"] = build_level(rows, cols)
            reset_ball(state)

        # Non-blocking input.
        try:
            ch = stdscr.getch()
        except curses.error:
            ch = -1

        if ch in (ord("q"), ord("Q"), 27):  # 27 == ESC
            return
        elif ch in (curses.KEY_LEFT, ord("a"), ord("A")):
            move_paddle(state, -1)
        elif ch in (curses.KEY_RIGHT, ord("d"), ord("D")):
            move_paddle(state, 1)
        elif ch in (ord(" "), ord("r")) and state["status"] in ("playing", "win", "gameover"):
            # Space / 'r' to (re)serve or restart.
            if state["status"] == "playing" and state["serving"]:
                serve_ball(state)
            elif state["status"] in ("win", "gameover"):
                # Restart the game.
                state["bricks"] = build_level(rows, cols)
                state["score"] = 0
                state["lives"] = STARTING_LIVES
                state["status"] = "playing"
                state["paddle_x"] = cols // 2 - PADDLE_WIDTH // 2
                reset_ball(state)

        # Serve logic: if serving, lock ball to paddle position.
        if state["serving"]:
            state["ball_y"] = state["paddle_y"] - 1
            state["ball_x"] = state["paddle_x"] + state["paddle_width"] // 2

        # Update ball only when not in serve state.
        if not state["serving"]:
            result = handle_collision(state)
            if result == "miss":
                state["lives"] -= 1
                if state["lives"] <= 0:
                    state["status"] = "gameover"
                    draw(state, stdscr)
                    show_message(state, stdscr, "GAME OVER")
                    # Wait for player action.
                    stdscr.nodelay(False)
                    while True:
                        try:
                            ch = stdscr.getch()
                        except curses.error:
                            ch = -1
                        if ch in (ord("q"), ord("Q"), 27):
                            return
                        if ch in (ord("r"), ord(" ")):
                            break
                    stdscr.nodelay(True)
                    # Restart.
                    state["bricks"] = build_level(rows, cols)
                    state["score"] = 0
                    state["lives"] = STARTING_LIVES
                    state["status"] = "playing"
                    state["paddle_x"] = cols // 2 - PADDLE_WIDTH // 2
                    reset_ball(state)
                    continue
                else:
                    # Reset for the next serve with a fresh ball.
                    reset_ball(state)
                    draw(state, stdscr)
                    time.sleep(0.6)
                    continue

        # Win check.
        if len(state["bricks"]) == 0 and state["status"] == "playing":
            state["status"] = "win"
            draw(state, stdscr)
            show_message(state, stdscr, "YOU WIN!")
            stdscr.nodelay(False)
            while True:
                try:
                    ch = stdscr.getch()
                except curses.error:
                    ch = -1
                if ch in (ord("q"), ord("Q"), 27):
                    return
                if ch in (ord("r"), ord(" ")):
                    break
            stdscr.nodelay(True)
            state["bricks"] = build_level(rows, cols)
            state["score"] = 0
            state["lives"] = STARTING_LIVES
            state["status"] = "playing"
            state["paddle_x"] = cols // 2 - PADDLE_WIDTH // 2
            reset_ball(state)
            continue

        draw(state, stdscr)
        time.sleep(FRAME_TIME)


if __name__ == "__main__":
    try:
        curses.wrapper(main)
    except KeyboardInterrupt:
        pass
