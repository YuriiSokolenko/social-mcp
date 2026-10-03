"""The interactive terminal loop: translate keys into actions and paint."""

from __future__ import annotations

import shutil
import sys
import time

from . import terminal
from .engine import OUTCOME_GAME_OVER, OUTCOME_WON, Engine
from .game import (
    ACTION_DIG_LEFT,
    ACTION_DIG_RIGHT,
    ACTION_DOWN,
    ACTION_LEFT,
    ACTION_NONE,
    ACTION_RIGHT,
    ACTION_UP,
)
from .levels import MIN_COLUMNS, MIN_ROWS
from .render import GLYPHS, Renderer

#: Action (or control command) for each canonical key command.
COMMAND_ACTIONS = {
    "left": ACTION_LEFT,
    "right": ACTION_RIGHT,
    "up": ACTION_UP,
    "down": ACTION_DOWN,
    "dig-left": ACTION_DIG_LEFT,
    "dig-right": ACTION_DIG_RIGHT,
}

TICK_SECONDS = 1 / 15.0


class GameLoop:
    """Drives the engine from keyboard input at a fixed tick rate."""

    def __init__(self, engine: Engine, renderer: Renderer, stdscr=None) -> None:
        self.engine = engine
        self.renderer = renderer
        self.stdscr = stdscr
        self.running = True
        self.pending = ACTION_NONE

    def handle_command(self, command: str) -> bool:
        """Apply one key command; returns False when the loop should stop."""
        engine = self.engine
        if command in COMMAND_ACTIONS:
            self.pending = COMMAND_ACTIONS[command]
        elif command == "pause":
            engine.toggle_pause()
        elif command == "restart":
            engine.restart_level()
        elif command == "help":
            self.renderer.help_overlay = not self.renderer.help_overlay
        elif command == "charset":
            self.renderer.charset = "unicode" if self.renderer.charset == "ascii" else "ascii"
            self.renderer.glyphs = GLYPHS[self.renderer.charset]
        elif command == "newgame":
            engine.restart()
        elif command == "quit":
            self.running = False
            return False
        return True

    def tick(self) -> None:
        action = self.pending
        self.pending = ACTION_NONE
        self.engine.step(action)
        if self.engine.outcome in (OUTCOME_GAME_OVER, OUTCOME_WON):
            self.running = False

    def draw(self) -> None:  # pragma: no cover - terminal side effect
        if self.stdscr is None:
            return
        columns, rows = self.stdscr.size()
        self.stdscr.paint(self.renderer.frame(self.engine, columns, rows))

    def run(self) -> None:
        """Run until quit or game over; never leaves the terminal in raw mode."""
        if self.stdscr is None:  # pragma: no cover - headless guard
            raise RuntimeError("GameLoop needs a terminal interface to run")
        with self.stdscr:
            while self.running:
                for command in self.stdscr.poll_commands():
                    if not self.handle_command(command):
                        break
                self.tick()
                self.draw()
                self.sleep(TICK_SECONDS)
        print("\nThanks for playing!")

    def sleep(self, seconds: float) -> None:  # pragma: no cover - timing hook
        time.sleep(seconds)


def terminal_size() -> tuple[int, int]:  # pragma: no cover - thin wrapper
    size = shutil.get_terminal_size((MIN_COLUMNS, MIN_ROWS))
    return size.columns, size.lines


def ensure_size() -> None:
    """Raise :class:`terminal.TerminalTooSmall` when the window is too small."""
    columns, rows = terminal_size()
    if columns < MIN_COLUMNS or rows < MIN_ROWS:
        raise terminal.TerminalTooSmall(
            f"terminal is {columns}x{rows}; lode_runner needs at least {MIN_COLUMNS}x{MIN_ROWS}"
        )


def main() -> int:  # pragma: no cover - the playable entry point
    """Play a full game; returns the process exit status."""
    try:
        columns, rows = terminal_size()
        terminal.check_size(rows, columns)
    except terminal.TerminalTooSmall as exc:
        print(f"error: {exc}", file=sys.stderr)
        print("Resize the window (or use a bigger terminal) and try again.", file=sys.stderr)
        return 2

    from .std_interface import StdInterface  # local import: only needed live

    engine = Engine()
    renderer = Renderer(charset="ascii")
    with StdInterface() as stdscr:
        GameLoop(engine, renderer, stdscr).run()
    return 0
