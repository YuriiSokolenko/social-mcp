"""A reversible in-memory text buffer with undo/redo history."""

from __future__ import annotations

from collections import deque

__all__ = [
    "EmptyHistoryError",
    "NoOpEditError",
    "TextBuffer",
    "TextBufferError",
]


class TextBufferError(Exception):
    """Base error for the text buffer exercise."""


class NoOpEditError(TextBufferError, ValueError):
    """A validly-addressed edit that would not change the text."""


class EmptyHistoryError(TextBufferError):
    """undo()/redo() was called with no entry available."""


class _Delta:
    """One recorded edit: removed/inserted characters at a char offset."""

    __slots__ = ("start", "removed", "inserted")

    def __init__(self, start: int, removed: str, inserted: str) -> None:
        self.start = start
        self.removed = removed
        self.inserted = inserted

    def apply(self, buf: list[str]) -> None:
        """Apply the forward delta (used by redo)."""
        buf[self.start : self.start + len(self.removed)] = list(self.inserted)

    def invert(self, buf: list[str]) -> None:
        """Apply the inverse delta (used by undo), restoring prior text."""
        buf[self.start : self.start + len(self.inserted)] = list(self.removed)

    def __repr__(self) -> str:  # pragma: no cover - debug aid only
        return f"_Delta(start={self.start}, removed={self.removed!r})"


class TextBuffer:
    """A reversible text buffer with delta-based undo/redo history."""

    def __init__(self, initial_text: str = "", history_limit: int = 50) -> None:
        if not isinstance(history_limit, int) or isinstance(history_limit, bool):
            raise TypeError("history_limit must be a positive integer")
        if history_limit <= 0:
            raise ValueError("history_limit must be a positive integer")
        self._buf: list[str] = list(initial_text)
        self._undo: deque[_Delta] = deque(maxlen=history_limit)
        self._redo: deque[_Delta] = deque(maxlen=history_limit)

    @property
    def text(self) -> str:
        """The current buffer content."""
        return "".join(self._buf)

    @property
    def can_undo(self) -> bool:
        return bool(self._undo)

    @property
    def can_redo(self) -> bool:
        return bool(self._redo)

    @property
    def history_size(self) -> int:
        """Number of undoable edits currently retained."""
        return len(self._undo)

    def __len__(self) -> int:
        return len(self._buf)

    def __str__(self) -> str:
        return self.text

    def insert(self, offset: int, chars: str) -> None:
        """Insert ``chars`` at character ``offset`` (0 <= offset <= len)."""
        self._check_offset(offset)
        if not chars:
            raise NoOpEditError("empty insert is a no-op edit")
        self._commit(_Delta(offset, "", chars))

    def delete(self, start: int, end: int) -> str:
        """Delete the half-open range ``[start, end)``; return removed text."""
        self._check_range(start, end)
        if start == end:
            raise NoOpEditError("empty range delete is a no-op edit")
        removed = "".join(self._buf[start:end])
        self._commit(_Delta(start, removed, ""))
        return removed

    def replace(self, start: int, end: int, chars: str) -> str:
        """Replace the half-open range ``[start, end)``; return old text."""
        self._check_range(start, end)
        old = "".join(self._buf[start:end])
        if old == chars:
            raise NoOpEditError("replace would not change the text")
        self._commit(_Delta(start, old, chars))
        return old

    def undo(self) -> str:
        """Undo the most recent mutation; return the resulting text."""
        if not self._undo:
            raise EmptyHistoryError("nothing to undo")
        delta = self._undo.pop()
        delta.invert(self._buf)
        self._redo.append(delta)
        return self.text

    def redo(self) -> str:
        """Redo the most recently undone mutation; return the resulting text."""
        if not self._redo:
            raise EmptyHistoryError("nothing to redo")
        delta = self._redo.pop()
        delta.apply(self._buf)
        self._undo.append(delta)
        return self.text

    def _check_offset(self, offset: int) -> None:
        if not isinstance(offset, int) or isinstance(offset, bool):
            raise TypeError("offset must be an integer")
        if not 0 <= offset <= len(self._buf):
            raise ValueError(f"offset {offset} outside 0..{len(self._buf)}")

    def _check_range(self, start: int, end: int) -> None:
        self._check_offset(start)
        self._check_offset(end)
        if start > end:
            raise ValueError(f"invalid range [{start}, {end}): start > end")

    def _commit(self, delta: _Delta) -> None:
        delta.apply(self._buf)
        self._undo.append(delta)
        self._redo.clear()
