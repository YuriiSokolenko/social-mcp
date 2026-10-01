"""Deterministic, UI-free Minesweeper engine.

The engine exists to exercise state transitions, neighbourhood traversal,
validation and immutable snapshots without touching the product or the harness
control plane. Mines are always supplied by the caller, so every game is
reproducible.

Terminal-state semantics
------------------------
A game starts ``PLAYING`` and becomes terminal when a mine is revealed
(``LOST``) or when every non-mine cell is revealed (``WON``). Both terminal
states are final: once the status leaves ``PLAYING`` no ``reveal``, ``flag`` or
``unflag`` operation mutates the board and the status never changes again.

Coordinates are ``(x, y)`` pairs where ``x`` is the column and ``y`` is the
row, both zero-based from the top-left corner.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Iterable

__all__ = [
    "BoardDimensionsError",
    "CellState",
    "GameStatus",
    "MinePositionError",
    "MinesweeperGame",
    "Snapshot",
]


class BoardDimensionsError(ValueError):
    """Raised when the board dimensions are not positive integers."""


class MinePositionError(ValueError):
    """Raised when supplied mine coordinates are unusable."""


class CellState(Enum):
    """The three mutually exclusive states a single cell can be in."""

    HIDDEN = "hidden"
    REVEALED = "revealed"
    FLAGGED = "flagged"


class GameStatus(Enum):
    """Lifecycle status of a game."""

    PLAYING = "playing"
    WON = "won"
    LOST = "lost"


@dataclass(frozen=True)
class Snapshot:
    """Immutable, read-only view of a board, suitable for test assertions.

    Snapshots are plain tuples, so a snapshot taken before an operation can be
    compared with a snapshot taken afterwards to prove nothing changed.

    Attributes:
        width: Board width in cells.
        height: Board height in cells.
        status: Game status when the snapshot was taken.
        mines: Sorted mine coordinates on the board.
        states: Row-major cell states.
        adjacent_mines: Row-major adjacent-mine counts.
    """

    width: int
    height: int
    status: GameStatus
    mines: tuple[tuple[int, int], ...]
    states: tuple[tuple[CellState, ...], ...]
    adjacent_mines: tuple[tuple[int, ...], ...]

    def state_at(self, x: int, y: int) -> CellState:
        """Return the recorded state of an in-bounds cell."""
        self._check(x, y)
        return self.states[y][x]

    def adjacent_at(self, x: int, y: int) -> int:
        """Return the recorded adjacent-mine count of an in-bounds cell."""
        self._check(x, y)
        return self.adjacent_mines[y][x]

    def _check(self, x: int, y: int) -> None:
        if not 0 <= x < self.width or not 0 <= y < self.height:
            raise IndexError(f"coordinate out of bounds: ({x}, {y})")

    @property
    def revealed_count(self) -> int:
        """How many cells are revealed."""
        return sum(
            1 for row in self.states for state in row if state is CellState.REVEALED
        )

    @property
    def flagged_count(self) -> int:
        """How many cells are flagged."""
        return sum(
            1 for row in self.states for state in row if state is CellState.FLAGGED
        )

    def __str__(self) -> str:
        """Render the snapshot as a grid; mines show only once the game is over."""
        return _render(
            self.states,
            self.adjacent_mines,
            frozenset(self.mines),
            self.status is GameStatus.LOST,
        )


class MinesweeperGame:
    """A deterministic Minesweeper board. All mines come from the caller.

    Args:
        width: Positive number of columns.
        height: Positive number of rows.
        mines: Iterable of ``(x, y)`` mine coordinates. Each coordinate must be
            in bounds and unique.

    Raises:
        BoardDimensionsError: If ``width`` or ``height`` is not a positive int.
        MinePositionError: If a mine coordinate is malformed, out of bounds, or
            a duplicate of another mine.
    """

    __slots__ = ("_width", "_height", "_mines", "_states", "_adjacent", "_status")

    def __init__(
        self,
        width: int,
        height: int,
        mines: Iterable[tuple[int, int]] = (),
    ) -> None:
        _check_dimensions(width, height)
        self._width = width
        self._height = height
        self._status = GameStatus.PLAYING
        self._states = [[CellState.HIDDEN] * width for _ in range(height)]
        self._mines = _validate_mines(mines, width, height)
        self._adjacent = self._compute_adjacent()

    # -- construction helpers ------------------------------------------------

    def _compute_adjacent(self) -> tuple[tuple[int, ...], ...]:
        grid = [[0] * self._width for _ in range(self._height)]
        for mx, my in self._mines:
            for nx, ny in self._neighbours(mx, my):
                grid[ny][nx] += 1
        return tuple(tuple(row) for row in grid)

    # -- public read API ----------------------------------------------------

    @property
    def width(self) -> int:
        """Number of columns."""
        return self._width

    @property
    def height(self) -> int:
        """Number of rows."""
        return self._height

    @property
    def status(self) -> GameStatus:
        """Current lifecycle status."""
        return self._status

    @property
    def mines(self) -> frozenset[tuple[int, int]]:
        """Immutable set of the mine coordinates on this board."""
        return self._mines

    @property
    def is_over(self) -> bool:
        """Whether the game reached the terminal ``WON``/``LOST`` state."""
        return self._status is not GameStatus.PLAYING

    def is_mine(self, x: int, y: int) -> bool:
        """Whether an in-bounds cell hides a mine."""
        self._check(x, y)
        return (x, y) in self._mines

    def adjacent_mines(self, x: int, y: int) -> int:
        """How many of the eight neighbours of an in-bounds cell are mines."""
        self._check(x, y)
        return self._adjacent[y][x]

    def cell_state(self, x: int, y: int) -> CellState:
        """Current state of an in-bounds cell."""
        self._check(x, y)
        return self._states[y][x]

    def hidden_count(self) -> int:
        """How many cells are not revealed yet."""
        return sum(
            1 for row in self._states for state in row if state is not CellState.REVEALED
        )

    def snapshot(self) -> Snapshot:
        """Return an immutable copy of the current board."""
        return Snapshot(
            width=self._width,
            height=self._height,
            status=self._status,
            mines=tuple(sorted(self._mines)),
            states=tuple(tuple(row) for row in self._states),
            adjacent_mines=self._adjacent,
        )

    def __str__(self) -> str:
        """Render the board as a grid; mines show only after a loss."""
        return _render(
            tuple(tuple(row) for row in self._states),
            self._adjacent,
            self._mines,
            self._status is GameStatus.LOST,
        )

    # -- public write API ---------------------------------------------------

    def reveal(self, x: int, y: int) -> GameStatus:
        """Reveal a cell, flooding outward from zero-adjacency cells.

        Revealing a mine loses the game. Revealing the final non-mine cell
        wins it. A flagged cell cannot be revealed and must be unflagged
        first. Revealing an already revealed cell is a no-op, and every
        operation is a no-op once the game is over.

        Args:
            x: Column of the cell to reveal.
            y: Row of the cell to reveal.

        Returns:
            The status after the operation.

        Raises:
            IndexError: If the coordinate is out of bounds.
            TypeError: If a coordinate is not an int.
        """
        self._check(x, y)
        if self.is_over:
            return self._status
        if self._states[y][x] is not CellState.HIDDEN:
            return self._status
        if (x, y) in self._mines:
            self._states[y][x] = CellState.REVEALED
            self._status = GameStatus.LOST
            return self._status
        self._flood(x, y)
        if self._safe_cells_revealed():
            self._status = GameStatus.WON
        return self._status

    def flag(self, x: int, y: int) -> GameStatus:
        """Flag an in-bounds hidden cell; idempotent and terminal-safe.

        Revealed cells are never turned into flags, and nothing changes once
        the game is over.
        """
        self._check(x, y)
        if self.is_over:
            return self._status
        if self._states[y][x] is CellState.HIDDEN:
            self._states[y][x] = CellState.FLAGGED
        return self._status

    def unflag(self, x: int, y: int) -> GameStatus:
        """Remove a flag from an in-bounds cell; idempotent and terminal-safe."""
        self._check(x, y)
        if self.is_over:
            return self._status
        if self._states[y][x] is CellState.FLAGGED:
            self._states[y][x] = CellState.HIDDEN
        return self._status

    def toggle_flag(self, x: int, y: int) -> GameStatus:
        """Flag a hidden cell, or remove the flag from a flagged cell."""
        self._check(x, y)
        if self._states[y][x] is CellState.FLAGGED:
            return self.unflag(x, y)
        return self.flag(x, y)

    def reveal_all(self) -> GameStatus:
        """Reveal every unflagged cell, honouring flags.

        Correct flags keep the game won; a flag standing on a non-mine leaves
        the mine underneath exposed and the game stays unplayed.
        """
        for y in range(self._height):
            for x in range(self._width):
                self.reveal(x, y)
        return self._status

    # -- internals ----------------------------------------------------------

    def _check(self, x: object, y: object) -> None:
        for name, value in (("x", x), ("y", y)):
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"{name} must be an int, got {value!r}")
        if not 0 <= x < self._width or not 0 <= y < self._height:  # type: ignore[arg-type]
            raise IndexError(f"coordinate out of bounds: ({x}, {y})")

    def _neighbours(self, x: int, y: int) -> list[tuple[int, int]]:
        """In-bounds cells touching ``(x, y)``, ordered top-left to bottom-right."""
        cells = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == dy == 0:
                    continue
                nx, ny = x + dx, y + dy
                if 0 <= nx < self._width and 0 <= ny < self._height:
                    cells.append((nx, ny))
        return cells

    def _flood(self, x: int, y: int) -> None:
        """Reveal ``(x, y)`` plus its zero-adjacency region and numbered border."""
        stack = [(x, y)]
        while stack:
            cx, cy = stack.pop()
            if self._states[cy][cx] is not CellState.HIDDEN:
                continue
            if (cx, cy) in self._mines:
                continue
            self._states[cy][cx] = CellState.REVEALED
            if self._adjacent[cy][cx] != 0:
                continue
            for nx, ny in self._neighbours(cx, cy):
                if self._states[ny][nx] is CellState.HIDDEN:
                    stack.append((nx, ny))

    def _safe_cells_revealed(self) -> bool:
        """Whether every non-mine cell is revealed."""
        return all(
            self._states[y][x] is CellState.REVEALED or (x, y) in self._mines
            for y in range(self._height)
            for x in range(self._width)
        )


def _check_dimensions(width: object, height: object) -> None:
    """Raise :class:`BoardDimensionsError` unless both dimensions are positive."""
    for name, value in (("width", width), ("height", height)):
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise BoardDimensionsError(f"{name} must be a positive int, got {value!r}")


def _validate_mines(
    mines: Iterable[tuple[int, int]], width: int, height: int
) -> frozenset[tuple[int, int]]:
    """Return validated mine coordinates as an immutable set.

    Raises:
        MinePositionError: If a coordinate is not a pair of ints, is outside
            the board, or repeats an earlier mine.
    """
    seen: set[tuple[int, int]] = set()
    for mine in mines:
        x, y = _coerce_position(mine)
        if not 0 <= x < width or not 0 <= y < height:
            raise MinePositionError(f"mine out of bounds: ({x}, {y})")
        if (x, y) in seen:
            raise MinePositionError(f"duplicate mine position: ({x}, {y})")
        seen.add((x, y))
    return frozenset(seen)


def _coerce_position(mine: object) -> tuple[int, int]:
    """Return one mine coordinate as ``(x, y)`` ints."""
    if not isinstance(mine, tuple) or len(mine) != 2:
        raise MinePositionError(f"mine must be a 2-element tuple, got {mine!r}")
    x, y = mine
    for name, value in (("x", x), ("y", y)):
        if isinstance(value, bool) or not isinstance(value, int):
            raise MinePositionError(f"mine {name} must be an int, got {value!r}")
    return x, y


def _render(
    states: tuple[tuple[CellState, ...], ...],
    adjacent: tuple[tuple[int, ...], ...],
    mines: frozenset[tuple[int, int]],
    show_mines: bool,
) -> str:
    """Render a grid for debugging and doctest-style inspection.

    ``#`` is hidden, ``F`` flagged, ``*`` an exposed mine, ``.`` a revealed
    zero, and ``1``-``8`` a revealed numbered cell.
    """
    rows = []
    for y, row in enumerate(states):
        cells = []
        for x, state in enumerate(row):
            if state is CellState.FLAGGED:
                cells.append("F")
            elif state is CellState.HIDDEN:
                cells.append("#")
            elif show_mines and (x, y) in mines:
                cells.append("*")
            else:
                cells.append(str(adjacent[y][x]) if adjacent[y][x] else ".")
        rows.append(" ".join(cells))
    return "\n".join(rows)

