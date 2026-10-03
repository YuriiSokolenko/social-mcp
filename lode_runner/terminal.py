"""Raw-mode terminal handling: keyboard input, painting, and clean restore.

Only this module touches ``termios``/``tty``; the game logic stays headless.
"""

from __future__ import annotations

import sys
from contextlib import contextmanager

MIN_COLUMNS = 60
MIN_ROWS = 22


class TerminalTooSmall(Exception):
    """The terminal cannot show the level and the status area."""


class Keyboard:
    """Non-blocking line/byte reader with arrow-key decoding.

    Reads one character at a time from ``stdin`` and translates escape
    sequences.  Repeated or held keys are simply more calls to :meth:`read`,
    which keeps the terminal from being flooded with unread bytes.
    """

    _ARROWS = {b"A": "up", b"B": "down", b"C": "right", b"D": "left"}

    def __init__(self, stream=None) -> None:
        self.stream = stream or sys.stdin

    def read(self) -> str | None:
        try:
            data = self.stream.read(1)
        except (EOFError, OSError):
            return None
        if not data:
            return None
        if data in ("\x1b\x5b", "\x1b"):
            # Escape sequence: arrow keys are ESC [ A..D.
            if data == "\x1b":
                rest = self.stream.read(2)
                if len(rest) == 2 and rest[0] == "[":
                    return self._ARROWS.get(rest[1].encode(), None) or rest[1]
            return None
        return data

    def close(self) -> None:  # pragma: no cover - symmetry hook
        return None


KEYMAP = {
    "left": "left",
    "right": "right",
    "up": "up",
    "down": "down",
}

#: Key -> canonical command.  Arrows are translated by :class:`Keyboard`.
COMMANDS = {
    "a": "left",
    "d": "right",
    "w": "up",
    "s": "down",
    "left": "left",
    "right": "right",
    "up": "up",
    "down": "down",
    "z": "dig-left",
    "x": "dig-right",
    "r": "restart",
    "p": "pause",
    "q": "quit",
    "h": "help",
    "c": "charset",
}


@contextmanager
def raw_mode(stream=None):
    """Put the tty in raw mode, always restoring it on the way out."""

    stream = stream or sys.stdin
    saved = None
    try:  # pragma: no cover - platform dependent
        import termios

        saved = termios.tcgetattr(stream.fileno())
    except (ImportError, OSError):  # not a tty, or unsupported platform
        saved = None
    else:
        import termios

        mode = termios.tcgetattr(stream.fileno())
        # Disable canonical mode and echo; keep signals so Ctrl-C still works.
        mode[3] = mode[3] & ~termios.ICANON & ~termios.ECHO
        termios.tcsetattr(stream.fileno(), termios.TCSADRAIN, mode)
        try:
            yield
        finally:
            termios.tcsetattr(stream.fileno(), termios.TCSADRAIN, saved)
        return

    try:
        yield
    finally:
        if saved is not None:  # pragma: no cover - defensive
            import termios

            termios.tcsetattr(stream.fileno(), termios.TCSADRAIN, saved)


def check_size(rows: int, columns: int) -> None:
    if rows < MIN_ROWS or columns < MIN_COLUMNS:
        raise TerminalTooSmall(
            f"terminal is {columns}x{rows}; this game needs at least {MIN_COLUMNS}x{MIN_ROWS}"
        )


def install_cursor() -> str:
    """ANSI preamble: hide the cursor while painting."""
    return "\x1b[?25l"


def restore_cursor() -> str:
    return "\x1b[?25h"


def paint(lines: list[str]) -> str:
    """A full-screen repaint string: home, clear, draw, show cursor."""
    body = "\n".join(lines)
    return "\x1b[?1049h\x1b[H\x1b[2J" + body + "\x1b[?25h"


def repaint(lines: list[str]) -> str:
    """An in-place frame: home, paint, and erase whatever remains below."""
    body = "\n".join(lines)
    return "\x1b[H" + body + "\x1b[0m\x1b[K"


def quit_string() -> str:
    """The trailing bytes written when the game stops."""
    return "\x1b[0m\n"
