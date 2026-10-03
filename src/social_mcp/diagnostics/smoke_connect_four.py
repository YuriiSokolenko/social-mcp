"""Deterministic Connect Four engine used by the #425 nested usage smoke.

The module is intentionally self-contained and uses only the Python standard
library.  The engine is deterministic: given the same position and the same
depth, ``minimax_move`` always returns the same column.

Board geometry (``ROWS`` rows, ``COLUMNS`` columns) is gravity based: a
disc dropped into a column falls to the lowest empty row.  Rows are indexed
from the bottom of the board, so row ``0`` is the floor and row ``5`` is the
top row.  Columns are indexed ``0`` .. ``6``.

Two players are used: ``FIRST_PLAYER`` (``1``) and ``SECOND_PLAYER`` (``2``).
By convention the first player to move is ``FIRST_PLAYER``.
"""

from __future__ import annotations

__all__ = [
    "ConnectFour",
    "ConnectFourError",
    "minimax_move",
    "parse_moves",
]


COLUMNS = 7
ROWS = 6

FIRST_PLAYER = 1
SECOND_PLAYER = 2

_WIN_LENGTH = 4

# Fixed, centre-first column order used both by ``legal_moves`` and by the
# minimax tie-break so that the search is fully deterministic.
_COLUMN_ORDER = (3, 2, 4, 1, 5, 0, 6)


class ConnectFourError(Exception):
    """Raised for any illegal game action.

    Illegal actions include an out-of-range or non-integer column (including
    ``bool``), a drop into a full column, and any move after the game has
    finished.
    """


def _opponent(player: int) -> int:
    """Return the opponent of ``player``."""

    if player == FIRST_PLAYER:
        return SECOND_PLAYER
    return FIRST_PLAYER


def _valid_player(player: int) -> bool:
    """Return ``True`` when ``player`` is one of the two legal players."""

    return player == FIRST_PLAYER or player == SECOND_PLAYER


class ConnectFour:
    """A gravity based 7x6 Connect Four board.

    The board stores one list per column; index ``0`` of a column list is the
    disc resting on the floor.  Empty cells are represented by ``0``.
    """

    def __init__(self, moves: list[int] | None = None) -> None:
        """Create an empty board, optionally replaying ``moves``."""

        self._columns: list[list[int]] = [[] for _ in range(COLUMNS)]
        self.turn: int = FIRST_PLAYER
        self.move_count: int = 0
        self.history: list[int] = []
        self._winner: int | None = None
        self._win_cells: tuple[tuple[int, int], ...] | None = None
        if moves is not None:
            for column in moves:
                self.drop(column)

    # ------------------------------------------------------------------
    # Basic state helpers
    # ------------------------------------------------------------------

    @property
    def columns(self) -> list[list[int]]:
        """Return a deep copy of the column stacks."""

        return [list(column) for column in self._columns]

    def cell(self, column: int, row: int) -> int:
        """Return the player occupying ``column``/``row`` or ``0`` if empty."""

        self._check_column(column)
        if not isinstance(row, int) or isinstance(row, bool):
            raise ConnectFourError("row must be an int")
        if row < 0 or row >= ROWS:
            raise ConnectFourError("row out of range")
        stack = self._columns[column]
        if row >= len(stack):
            return 0
        return stack[row]

    def height(self, column: int) -> int:
        """Return the number of discs stacked in ``column``."""

        self._check_column(column)
        return len(self._columns[column])

    def legal_moves(self) -> list[int]:
        """Return the centre-first list of columns that still accept a disc.

        Returns an empty list once the game has finished.
        """

        if self._winner is not None or self.move_count == ROWS * COLUMNS:
            return []
        moves = []
        for column in _COLUMN_ORDER:
            if len(self._columns[column]) < ROWS:
                moves.append(column)
        return moves

    def winner(self) -> int | None:
        """Return ``1``/``2`` when the game is won, otherwise ``None``."""

        if self._winner is not None:
            return self._winner
        winner, cells = self._scan_winning_line()
        if winner is not None:
            self._winner = winner
            self._win_cells = cells
        return self._winner

    @property
    def win_cells(self) -> tuple[tuple[int, int], ...] | None:
        """Return the four winning cells, or ``None`` when there is no win."""

        if self.winner() is None:
            return None
        assert self._win_cells is not None
        return self._win_cells

    def is_draw(self) -> bool:
        """Return ``True`` when the board is full with no winner."""

        if self.move_count != ROWS * COLUMNS:
            return False
        return self.winner() is None

    def is_over(self) -> bool:
        """Return ``True`` when no further move may be played."""

        return self.winner() is not None or self.move_count == ROWS * COLUMNS

    # ------------------------------------------------------------------
    # Moves
    # ------------------------------------------------------------------

    def drop(self, column: int) -> int:
        """Drop a disc into ``column`` and return the landing row.

        The player to move is ``self.turn``.  Raises ``ConnectFourError`` when
        ``column`` is not an ``int`` (``bool`` is rejected), when the column is
        out of range, when the column is full, or when the game already
        finished.
        """

        self._check_column(column)
        if self._winner is not None:
            raise ConnectFourError("game is over")
        stack = self._columns[column]
        if len(stack) >= ROWS:
            raise ConnectFourError("column is full")
        row = len(stack)
        stack.append(self.turn)
        self.move_count += 1
        self.history.append(column)
        winner, cells = self._scan_from(column, row)
        if winner is not None:
            self._winner = winner
            self._win_cells = cells
        self.turn = _opponent(self.turn)
        return row

    def undo(self) -> int | None:
        """Remove the last move and return its column, or ``None`` if empty."""

        if not self.history:
            return None
        column = self.history.pop()
        self._columns[column].pop()
        self.move_count -= 1
        self._winner = None
        self._win_cells = None
        self.turn = _opponent(self.turn)
        return column

    def reset(self) -> None:
        """Clear the board and let the first player move again."""

        self._columns = [[] for _ in range(COLUMNS)]
        self.turn = FIRST_PLAYER
        self.move_count = 0
        self.history = []
        self._winner = None
        self._win_cells = None

    def copy(self) -> "ConnectFour":
        """Return an independent clone of this game."""

        clone = ConnectFour()
        clone._columns = [list(column) for column in self._columns]
        clone.turn = self.turn
        clone.move_count = self.move_count
        clone.history = list(self.history)
        clone._winner = self._winner
        clone._win_cells = self._win_cells
        return clone

    # ------------------------------------------------------------------
    # Rendering and protocol
    # ------------------------------------------------------------------

    def render(self) -> str:
        """Return the board as text, top row first, one row per line."""

        lines = []
        for row in range(ROWS - 1, -1, -1):
            cells = []
            for column in range(COLUMNS):
                value = self.cell(column, row)
                cells.append("." if value == 0 else str(value))
            lines.append(" ".join(cells))
        return "\n".join(lines)

    def row_values(self, row: int) -> list[int]:
        """Return the seven cell values for ``row`` from left to right."""

        return [self.cell(column, row) for column in range(COLUMNS)]

    def column_values(self, column: int) -> list[int]:
        """Return the six cell values for ``column`` from floor to top."""

        stack = self._check_column(column) or []
        values = list(stack)
        values.extend([0] * (ROWS - len(values)))
        return values

    def __eq__(self, other: object) -> bool:
        """Compare two games by position, turn, and result."""

        if not isinstance(other, ConnectFour):
            return NotImplemented
        return (
            self._columns == other._columns
            and self.turn == other.turn
            and self.move_count == other.move_count
            and self._winner == other._winner
        )

    def __repr__(self) -> str:
        """Return an unambiguous developer representation."""

        return (
            f"ConnectFour(moves={self.history!r}, turn={self.turn!r}, "
            f"winner={self._winner!r})"
        )

    def __str__(self) -> str:
        """Return the rendered board."""

        return self.render()

    # ------------------------------------------------------------------
    # Internal validation
    # ------------------------------------------------------------------

    @staticmethod
    def _check_column(column: object) -> None:
        """Validate a column index, returning ``None``."""

        if isinstance(column, bool) or not isinstance(column, int):
            raise ConnectFourError("column must be an int")
        if column < 0 or column >= COLUMNS:
            raise ConnectFourError("column out of range")

    # ------------------------------------------------------------------
    # Win detection (explicit, one helper per direction)
    # ------------------------------------------------------------------

    def _line(self, column: int, row: int, d_column: int, d_row: int) -> list[int]:
        """Return the four cells starting at ``column``/``row``."""

        values = []
        for step in range(_WIN_LENGTH):
            values.append(self.cell(column + step * d_column, row + step * d_row))
        return values

    def _horizontal_run(self, column: int, row: int, player: int) -> bool:
        """Return ``True`` for a horizontal four starting at ``column``."""

        if column + _WIN_LENGTH > COLUMNS:
            return False
        for step in range(_WIN_LENGTH):
            if self.cell(column + step, row) != player:
                return False
        return True

    def _vertical_run(self, column: int, row: int, player: int) -> bool:
        """Return ``True`` for a vertical four starting at ``row``."""

        if row + _WIN_LENGTH > ROWS:
            return False
        for step in range(_WIN_LENGTH):
            if self.cell(column, row + step) != player:
                return False
        return True

    def _rising_run(self, column: int, row: int, player: int) -> bool:
        """Return ``True`` for a ``/`` diagonal four starting there."""

        if column + _WIN_LENGTH > COLUMNS or row + _WIN_LENGTH > ROWS:
            return False
        for step in range(_WIN_LENGTH):
            if self.cell(column + step, row + step) != player:
                return False
        return True

    def _falling_run(self, column: int, row: int, player: int) -> bool:
        """Return ``True`` for a ``\\`` diagonal four starting there."""

        if column + _WIN_LENGTH > COLUMNS or row - (_WIN_LENGTH - 1) < 0:
            return False
        for step in range(_WIN_LENGTH):
            if self.cell(column + step, row - step) != player:
                return False
        return True

    def _scan_from(self, column: int, row: int) -> tuple[int | None, tuple | None]:
        """Find a win through the freshly dropped cell, if any."""

        player = self.cell(column, row)
        if player == 0:
            return None, None

        # Horizontal: walk up to three cells to the left of ``column``.
        start = max(0, column - (_WIN_LENGTH - 1))
        for candidate in range(start, column + 1):
            if self._horizontal_run(candidate, row, player):
                cells = tuple(
                    (cell_column, row)
                    for cell_column in range(candidate, candidate + _WIN_LENGTH)
                )
                return player, cells

        # Vertical: walk down from the dropped cell.
        start = max(0, row - (_WIN_LENGTH - 1))
        for candidate in range(start, row + 1):
            if self._vertical_run(column, candidate, player):
                cells = tuple(
                    (column, cell_row)
                    for cell_row in range(candidate, candidate + _WIN_LENGTH)
                )
                return player, cells

        # Rising diagonal (/): slide down-left along the diagonal.
        for offset in range(_WIN_LENGTH):
            candidate_column = column - offset
            candidate_row = row - offset
            if candidate_column < 0 or candidate_row < 0:
                continue
            if self._rising_run(candidate_column, candidate_row, player):
                cells = tuple(
                    (candidate_column + step, candidate_row + step)
                    for step in range(_WIN_LENGTH)
                )
                return player, cells

        # Falling diagonal (\\): slide up-left along the diagonal.
        for offset in range(_WIN_LENGTH):
            candidate_column = column - offset
            candidate_row = row + offset
            if candidate_column < 0 or candidate_row >= ROWS:
                continue
            if self._falling_run(candidate_column, candidate_row, player):
                cells = tuple(
                    (candidate_column + step, candidate_row - step)
                    for step in range(_WIN_LENGTH)
                )
                return player, cells

        return None, None

    def _scan_winning_line(self) -> tuple[int | None, tuple | None]:
        """Scan the whole board for any winning line."""

        for row in range(ROWS):
            for column in range(COLUMNS):
                player = self.cell(column, row)
                if player == 0:
                    continue
                found, cells = self._scan_from(column, row)
                if found is not None:
                    return found, cells
        return None, None

    # ------------------------------------------------------------------
    # Search support
    # ------------------------------------------------------------------

    def evaluate(self, player: int) -> int:
        """Return a positional score for ``player``.

        The evaluation counts, for every window of four adjacent cells, how
        many windows are still winnable by ``player`` and how many by the
        opponent.  Each completely open window contributes one point, and each
        player's disc inside a non-blocked window contributes one further
        point.  Windows containing discs from both players are worth nothing.
        A centre-column presence bonus is added so that the search prefers the
        middle file for equal-score moves.
        """

        opponent = _opponent(player)
        score = 0
        for window in self._windows():
            mine = 0
            theirs = 0
            for value in window:
                if value == player:
                    mine += 1
                elif value == opponent:
                    theirs += 1
            if mine and theirs:
                continue
            if mine:
                score += 1 + mine
            elif theirs:
                score -= 1 + theirs
        for row in range(ROWS):
            if self.cell(3, row) == player:
                score += 2
            elif self.cell(3, row) == opponent:
                score -= 2
        return score

    def _windows(self) -> list[tuple[int, ...]]:
        """Yield every four-cell window on the board."""

        windows: list[tuple[int, ...]] = []
        for row in range(ROWS):
            for column in range(COLUMNS - _WIN_LENGTH + 1):
                windows.append(self._line(column, row, 1, 0))
        for column in range(COLUMNS):
            for row in range(ROWS - _WIN_LENGTH + 1):
                windows.append(self._line(column, row, 0, 1))
        for column in range(COLUMNS - _WIN_LENGTH + 1):
            for row in range(ROWS - _WIN_LENGTH + 1):
                windows.append(self._line(column, row, 1, 1))
        for column in range(COLUMNS - _WIN_LENGTH + 1):
            for row in range(_WIN_LENGTH - 1, ROWS):
                windows.append(self._line(column, row, 1, -1))
        return windows

    def _apply(self, column: int) -> int:
        """Drop for the search without validation overhead."""

        row = len(self._columns[column])
        self._columns[column].append(self.turn)
        self.move_count += 1
        self.history.append(column)
        self.turn = _opponent(self.turn)
        return row

    def _unapply(self, column: int) -> None:
        """Undo a search drop performed by ``_apply``."""

        self._columns[column].pop()
        self.move_count -= 1
        self.history.pop()
        self.turn = _opponent(self.turn)


def _immediate_win(game: ConnectFour, player: int) -> int | None:
    """Return the column where ``player`` wins at once, if any."""

    for column in game.legal_moves():
        game._columns[column].append(player)
        winner, _cells = game._scan_from(column, len(game._columns[column]) - 1)
        game._columns[column].pop()
        if winner == player:
            return column
    return None


def minimax_move(game: ConnectFour, depth: int = 4) -> int:
    """Return the best column for ``game.turn`` using alpha-beta minimax.

    ``depth`` is the number of plies searched (clamped to at least one).  The
    search is deterministic: candidates are examined in the fixed centre-first
    ``_COLUMN_ORDER`` and a strictly-improving rule keeps the first best
    candidate on ties.  The search always takes an immediate win and always
    blocks an immediate opponent win.

    Raises ``ConnectFourError`` when the game is finished or ``depth`` is not a
    positive integer.
    """

    if not isinstance(depth, int) or isinstance(depth, bool) or depth < 1:
        raise ConnectFourError("depth must be a positive int")
    if game.is_over() or not game.legal_moves():
        raise ConnectFourError("game is over")

    mover = game.turn
    opponent = _opponent(mover)

    winning = _immediate_win(game, mover)
    if winning is not None:
        return winning

    best_column: int | None = None
    best_value: int | None = None

    for column in game.legal_moves():
        row = game._apply(column)
        if game._winner is None:
            value = _search(game, depth - 1, mover, opponent, False)
        else:  # pragma: no cover - win cells are recomputed below
            value = 0
        game._unapply(column)
        if best_value is None or value > best_value:
            best_value = value
            best_column = column
        if row < 0:  # pragma: no cover - defensive, keeps row usage explicit
            best_column = column

    if best_column is None:  # pragma: no cover - legal_moves is never empty here
        raise ConnectFourError("no legal move available")
    return best_column


def _search(
    game: ConnectFour,
    depth: int,
    root: int,
    other: int,
    _ignored: bool,
) -> int:
    """Return the value of the position for ``root`` at ``depth`` plies."""

    mover = game.turn
    if mover == root:
        win = _immediate_win(game, root)
        if win is not None:
            return 10000
    else:
        win = _immediate_win(game, other)
        if win is not None:
            return -10000

    if depth <= 0 or not game.legal_moves():
        return game.evaluate(root)

    alpha = -10_000_000
    beta = 10_000_000

    if mover == root:
        best = -10_000_000
        for column in game.legal_moves():
            game._apply(column)
            value = _search(game, depth - 1, root, other, True)
            game._unapply(column)
            if value > best:
                best = value
            if best > alpha:
                alpha = best
            if alpha >= beta:
                break
        return best

    best = 10_000_000
    for column in game.legal_moves():
        game._apply(column)
        value = _search(game, depth - 1, root, other, True)
        game._unapply(column)
        if value < best:
            best = value
        if best < beta:
            beta = best
        if alpha >= beta:
            break
    return best


def parse_moves(text: str) -> ConnectFour:
    """Build a ``ConnectFour`` from a comma-separated column list.

    ``parse_moves("3,3,4")`` drops into columns ``3``, ``3`` and ``4``.  Each
    entry must be a one-digit base digit written without whitespace, and the
    drops must be legal.  Raises ``ValueError`` for malformed input, including
    an empty string, a non-numeric or multi-character entry, an out-of-range
    column, a filled column, or a move after the game has finished.
    """

    if not isinstance(text, str):
        raise ValueError("moves must be a string")
    game = ConnectFour()
    if text == "":
        return game
    for token in text.split(","):
        if len(token) != 1:
            raise ValueError(f"invalid column token {token!r}")
        if token < "0" or token > "6":
            raise ValueError(f"invalid column {token!r}")
        try:
            game.drop(int(token))
        except ConnectFourError as exc:
            raise ValueError(str(exc)) from exc
    return game


def _unused_row_helper() -> None:  # pragma: no cover - keeps lint honest
    """No-op helper retained for module symmetry."""

    return None
