"""Standard-IO terminal interface: raw mode, key decoding, in-place painting.

This is the only module that touches ``termios``/``tty`` at runtime.
"""

from __future__ import annotations

import os
import sys

from .terminal import Keyboard, paint, repaint

_ESCAPE_COMMANDS = {
    b"A": "up",
    b"B": "down",
    b"C": "right",
    b"D": "left",
}


class StdInterface:
    """Raw-mode keyboard + full-frame painter over stdin/stdout."""

    def __init__(self, stream_in=None, stream_out=None) -> None:
        self.stdin = stream_in or sys.stdin
        self.stdout = stream_out or sys.stdout
        self.keyboard = Keyboard(self.stdin)
        self._saved = None
        self._rows = 0
        self._columns = 0

    # --------------------------------------------------------- terminal setup
    def __enter__(self) -> "StdInterface":
        self._enable_raw_mode()
        self.stdout.write(paint([]))
        self.stdout.flush()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self._disable_raw_mode()
        self.stdout.write("\x1b[0m\x1b[?25h")
        self.stdout.flush()

    def _enable_raw_mode(self) -> None:
        try:
            import termios

            self._saved = termios.tcgetattr(self.stdin.fileno())
        except (ImportError, OSError):
            self._saved = None
            return
        import termios

        mode = termios.tcgetattr(self.stdin.fileno())
        mode[3] = mode[3] & ~termios.ICANON & ~termios.ECHO
        termios.tcsetattr(self.stdin.fileno(), termios.TCSADRAIN, mode)

    def _disable_raw_mode(self) -> None:
        if self._saved is None:
            return
        try:
            import termios

            termios.tcsetattr(self.stdin.fileno(), termios.TCSADRAIN, self._saved)
        except (ImportError, OSError):  # pragma: no cover - platform quirk
            pass
        self._saved = None

    # ---------------------------------------------------------------- input
    def poll_commands(self) -> list[str]:
        """Drain everything the user typed and translate it into commands."""
        commands: list[str] = []
        while True:
            command = self._read_command()
            if command is None:
                break
            commands.append(command)
        return commands

    def _read_command(self) -> str | None:
        try:
            import termios

            available = termios.tioctl(self.stdin.fileno(), termios.FIONREAD)
        except (ImportError, OSError):
            available = 0
        if not available:
            return None
        key = self.keyboard.read()
        return _COMMAND_FROM_KEY(key) if key else None

    # -------------------------------------------------------------- painting
    def paint(self, lines: list[str]) -> None:
        self.stdout.write(repaint(lines))
        self.stdout.flush()

    def size(self) -> tuple[int, int]:
        """Current ``(columns, rows)`` of the terminal."""
        try:
            size = os.get_terminal_size(self.stdout.fileno())
            return size.columns, size.lines
        except OSError:
            import shutil

            fallback = shutil.get_terminal_size((80, 24))
            return fallback.columns, fallback.lines


def _command(key: str) -> str | None:
    from .terminal import COMMANDS

    return COMMANDS.get(key.lower())


def _COMMAND_FROM_KEY(key: str) -> str | None:
    if key in _ESCAPE_COMMANDS.values():
        return key
    from .terminal import COMMANDS

    return COMMANDS.get(key.lower())
