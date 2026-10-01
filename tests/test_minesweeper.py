"""Focused tests for the deterministic Minesweeper exercise."""

import pytest

from social_mcp.exercises.minesweeper import BoardDimensionsError
from social_mcp.exercises.minesweeper import CellState
from social_mcp.exercises.minesweeper import GameStatus
from social_mcp.exercises.minesweeper import MinePositionError
from social_mcp.exercises.minesweeper import MinesweeperGame
from social_mcp.exercises.minesweeper import Snapshot


def game(mines=()):
    return MinesweeperGame(5, 5, mines)


# ----------------------------------------------------------------------
# validation


@pytest.mark.parametrize("width", [0, -1, 1.5, True, "3", None])
def test_rejects_invalid_width(width):
    with pytest.raises(BoardDimensionsError):
        MinesweeperGame(width, 3)


@pytest.mark.parametrize("height", [0, -2, 2.0, False, "3", None])
def test_rejects_invalid_height(height):
    with pytest.raises(BoardDimensionsError):
        MinesweeperGame(3, height)


@pytest.mark.parametrize(
    "mine",
    [(-1, 0), (0, -1), (3, 0), (0, 3), (99, 99)],
)
def test_rejects_out_of_bounds_mine(mine):
    with pytest.raises(MinePositionError):
        MinesweeperGame(3, 3, [mine])


@pytest.mark.parametrize("mine", [(0,), (0, 0, 0), (0, "1"), ("0", 0), 5, None])
def test_rejects_malformed_mine(mine):
    with pytest.raises(MinePositionError):
        MinesweeperGame(3, 3, [mine])


def test_rejects_duplicate_mine():
    with pytest.raises(MinePositionError):
        MinesweeperGame(3, 3, [(1, 1), (1, 1)])


def test_accepts_minimal_valid_board():
    board = MinesweeperGame(1, 1, [])
    assert (board.width, board.height) == (1, 1)
    assert board.status is GameStatus.PLAYING
    assert board.mines == frozenset()


# ----------------------------------------------------------------------
# adjacent mine counts


def test_adjacent_counts_at_corner_edge_and_center():
    board = MinesweeperGame(3, 3, [(0, 0)])

    assert board.adjacent_mines(0, 0) == 0  # the mine cell itself
    assert board.adjacent_mines(1, 0) == 1  # edge neighbour
    assert board.adjacent_mines(0, 1) == 1  # edge neighbour
    assert board.adjacent_mines(1, 1) == 1  # centre neighbour
    assert board.adjacent_mines(2, 2) == 0  # opposite corner


def test_corner_cell_sees_only_three_neighbours():
    board = MinesweeperGame(3, 3, [(0, 0), (0, 1), (1, 0)])
    # (2, 2) is the opposite corner and sees nothing.
    assert board.adjacent_mines(2, 2) == 0


def test_edge_cell_counts_only_in_bound_neighbours():
    board = MinesweeperGame(3, 3, [(0, 0), (1, 0), (2, 0)])
    # (1, 2) is on the bottom edge; the whole mine row sits two rows above.
    assert board.adjacent_mines(1, 2) == 0


def test_edge_cell_counts_its_three_visible_neighbours():
    board = MinesweeperGame(3, 3, [(0, 1), (1, 1), (2, 1)])
    # (1, 0) is an edge cell whose three lower neighbours are all mines.
    assert board.adjacent_mines(1, 0) == 3


def test_center_cell_counts_all_eight_neighbours():
    mines = [(x, y) for x in (0, 1, 2) for y in (0, 1, 2) if (x, y) != (1, 1)]
    board = MinesweeperGame(3, 3, mines)
    assert board.adjacent_mines(1, 1) == 8


# ----------------------------------------------------------------------
# simple reveal


def test_reveal_numbered_cell_does_not_flood():
    board = MinesweeperGame(3, 3, [(0, 0)])
    board.reveal(1, 1)

    assert board.cell_state(1, 1) is CellState.REVEALED
    assert board.cell_state(2, 2) is CellState.HIDDEN
    assert board.status is GameStatus.PLAYING


def test_reveal_returns_status():
    board = MinesweeperGame(3, 3, [(0, 0)])
    assert board.reveal(1, 1) is GameStatus.PLAYING


def test_reveal_out_of_bounds_raises():
    board = game()
    with pytest.raises(IndexError):
        board.reveal(5, 0)
    with pytest.raises(IndexError):
        board.reveal(-1, 0)


def non_numeric_cells(board):
    return {
        (x, y): board.cell_state(x, y)
        for y in range(board.height)
        for x in range(board.width)
    }


# ----------------------------------------------------------------------
# flood reveal


def test_zero_region_flood_reveals_boundary_numbers():
    board = MinesweeperGame(5, 5, [(0, 0)])

    # (3, 3) has no adjacent mines, so the flood must expand and stop on the
    # numbered cells around the mine.
    board.reveal(3, 3)

    assert board.cell_state(3, 3) is CellState.REVEALED
    assert board.cell_state(0, 0) is CellState.HIDDEN  # mine stays hidden
    assert board.cell_state(1, 1) is CellState.REVEALED  # numbered boundary
    assert board.cell_state(1, 0) is CellState.REVEALED
    assert board.cell_state(0, 1) is CellState.REVEALED
    assert board.cell_state(4, 4) is CellState.REVEALED


def test_flood_stops_on_numbered_boundary_cells():
    board = MinesweeperGame(5, 5, [(4, 4)])

    board.reveal(0, 0)

    assert board.cell_state(0, 0) is CellState.REVEALED
    assert board.cell_state(2, 2) is CellState.REVEALED  # zero region interior
    assert board.cell_state(3, 3) is CellState.REVEALED  # numbered boundary "1"
    assert board.cell_state(4, 3) is CellState.REVEALED  # numbered boundary "1"
    assert board.cell_state(3, 4) is CellState.REVEALED  # numbered boundary "1"
    assert board.cell_state(4, 4) is CellState.HIDDEN  # the mine itself
    assert board.cell_state(2, 3) is CellState.REVEALED  # zero region reaches round
    assert board.cell_state(4, 0) is CellState.REVEALED  # zero region reaches round
    assert board.cell_state(0, 4) is CellState.REVEALED  # diagonal reach
    # Only the mine and the cells that a "1" boundary blocks stay hidden, which
    # the neighbouring tests assert explicitly.


def test_flagged_cell_inside_region_still_floods_past_it():
    board = MinesweeperGame(5, 5, [(4, 4)])
    board.flag(1, 1)

    board.reveal(0, 0)

    assert board.cell_state(1, 1) is CellState.FLAGGED
    assert board.cell_state(2, 2) is CellState.REVEALED
    assert board.cell_state(3, 3) is CellState.REVEALED


# ----------------------------------------------------------------------
# flags


def test_flag_and_unflag_toggle_state():
    board = game([(0, 0)])

    assert board.flag(2, 2) is GameStatus.PLAYING
    assert board.cell_state(2, 2) is CellState.FLAGGED

    assert board.unflag(2, 2) is GameStatus.PLAYING
    assert board.cell_state(2, 2) is CellState.HIDDEN


def test_flag_is_idempotent_and_does_not_reveal():
    board = game([(0, 0)])
    board.flag(2, 2)
    board.flag(2, 2)

    assert board.cell_state(2, 2) is CellState.FLAGGED
    assert board.snapshot().flagged_count == 1


def test_unflag_on_unflagged_cell_is_noop():
    board = game([(0, 0)])
    board.unflag(2, 2)
    board.unflag(2, 2)

    assert board.cell_state(2, 2) is CellState.HIDDEN


def test_flag_cannot_reveal_or_unreveal_a_cell():
    board = game([(0, 0)])
    board.reveal(2, 2)
    board.flag(2, 2)

    assert board.cell_state(2, 2) is CellState.REVEALED


def test_cannot_flag_revealed_cell():
    board = game([(0, 0)])
    board.reveal(4, 4)
    board.flag(4, 4)

    assert board.cell_state(4, 4) is CellState.REVEALED


def test_reveal_flagged_cell_is_a_noop():
    board = MinesweeperGame(3, 3, [(1, 1)])
    board.flag(1, 1)

    assert board.reveal(1, 1) is GameStatus.PLAYING
    assert board.cell_state(1, 1) is CellState.FLAGGED
    assert board.status is GameStatus.PLAYING


def test_toggle_flag():
    board = game([(0, 0)])
    board.toggle_flag(2, 2)
    assert board.cell_state(2, 2) is CellState.FLAGGED
    board.toggle_flag(2, 2)
    assert board.cell_state(2, 2) is CellState.HIDDEN


# ----------------------------------------------------------------------
# loss and win


def test_revealing_a_mine_loses():
    board = MinesweeperGame(3, 3, [(1, 1)])

    assert board.reveal(1, 1) is GameStatus.LOST
    assert board.status is GameStatus.LOST
    assert board.is_over is True
    assert board.cell_state(1, 1) is CellState.REVEALED


def test_win_when_all_safe_cells_revealed():
    board = MinesweeperGame(3, 3, [(0, 0)])

    for y in range(3):
        for x in range(3):
            if (x, y) != (0, 0):
                board.reveal(x, y)

    assert board.status is GameStatus.WON
    assert board.is_over is True


def test_flood_can_win_the_game():
    board = MinesweeperGame(3, 3, [(0, 0)])

    board.reveal(2, 2)

    assert board.status is GameStatus.WON


def test_flagged_safe_cells_do_not_block_win_once_revealed():
    board = MinesweeperGame(2, 2, [(0, 0)])
    board.flag(1, 1)
    board.reveal(1, 0)
    assert board.status is GameStatus.PLAYING

    board.unflag(1, 1)
    board.reveal(1, 1)

    # Remaining hidden cell is the safe one at (0, 1); reveal via (0, 1) too.
    board.reveal(0, 1)
    assert board.status is GameStatus.WON


def test_mine_never_auto_revealed_by_flood():
    board = MinesweeperGame(3, 3, [(1, 1)])
    board.reveal(0, 0)

    assert board.cell_state(1, 1) is CellState.HIDDEN
    assert board.status is GameStatus.PLAYING


# ----------------------------------------------------------------------
# repeated and terminal operations


def test_reveal_revealed_cell_is_idempotent():
    board = game([(0, 0)])
    board.reveal(4, 4)
    before = board.snapshot()

    board.reveal(4, 4)

    assert board.snapshot() == before


def test_no_state_changes_after_loss():
    board = MinesweeperGame(3, 3, [(1, 1)])
    board.reveal(1, 1)
    before = board.snapshot()

    assert board.reveal(0, 0) is GameStatus.LOST
    assert board.flag(2, 2) is GameStatus.LOST
    assert board.unflag(2, 2) is GameStatus.LOST
    board.toggle_flag(0, 2)

    assert board.snapshot() == before
    assert board.status is GameStatus.LOST


def test_no_state_changes_after_win():
    board = MinesweeperGame(3, 3, [(0, 0)])
    board.reveal(2, 2)
    assert board.status is GameStatus.WON
    before = board.snapshot()

    assert board.reveal(0, 0) is GameStatus.WON
    assert board.flag(0, 0) is GameStatus.WON

    assert board.snapshot() == before
    assert board.status is GameStatus.WON


def test_reveal_all_exposes_mine_and_loses():
    board = MinesweeperGame(3, 3, [(1, 1)])

    assert board.reveal_all() is GameStatus.LOST


def test_reveal_all_with_correct_flags_wins():
    board = MinesweeperGame(3, 3, [(1, 1)])
    board.flag(1, 1)

    assert board.reveal_all() is GameStatus.WON
    assert board.cell_state(1, 1) is CellState.FLAGGED


# ----------------------------------------------------------------------
# snapshots


def test_snapshot_is_immutable_and_detached():
    board = MinesweeperGame(3, 3, [(1, 1)])
    board.reveal(0, 0)
    before = board.snapshot()

    board.reveal(2, 2)

    assert isinstance(before, Snapshot)
    assert before.status is GameStatus.PLAYING
    assert before.state_at(2, 2) is CellState.HIDDEN
    assert board.cell_state(2, 2) is CellState.REVEALED


def test_snapshot_reads_and_counts():
    board = MinesweeperGame(3, 3, [(1, 1)])
    board.reveal(0, 0)
    board.flag(2, 2)
    snapshot = board.snapshot()

    assert snapshot.width == 3
    assert snapshot.height == 3
    assert snapshot.status is GameStatus.PLAYING
    assert snapshot.mines == frozenset({(1, 1)})
    assert snapshot.adjacent_at(0, 0) == 1
    assert snapshot.adjacent_at(1, 1) == 0
    assert snapshot.state_at(0, 0) is CellState.REVEALED
    assert snapshot.state_at(1, 1) is CellState.HIDDEN
    assert snapshot.state_at(2, 2) is CellState.FLAGGED
    assert snapshot.revealed_count == 1
    assert snapshot.flagged_count == 1


def test_snapshot_rejects_out_of_bounds_reads():
    snapshot = MinesweeperGame(2, 2, []).snapshot()

    with pytest.raises(IndexError):
        snapshot.state_at(2, 0)
    with pytest.raises(IndexError):
        snapshot.adjacent_at(-1, 0)


def test_snapshot_str_is_readable():
    board = MinesweeperGame(3, 3, [(1, 1)])
    board.reveal(0, 0)

    text = str(board.snapshot())

    assert text.splitlines()[0] == "1 # #"
    assert "#" in text


def test_read_api_rejects_out_of_bounds_and_bad_types():
    board = game([(0, 0)])

    with pytest.raises(IndexError):
        board.cell_state(0, 5)
    with pytest.raises(IndexError):
        board.adjacent_mines(5, 5)
    with pytest.raises(IndexError):
        board.is_mine(-1, -1)
    with pytest.raises(TypeError):
        board.reveal(0.5, 0)


def test_unrevealed_count_tracks_progress():
    board = MinesweeperGame(3, 3, [(1, 1)])
    assert board.unrevealed_count() == 9

    board.reveal(0, 0)

    # Revealing the numbered cell at (0, 0) does not flood, so only the eight
    # remaining cells (including the mine) stay hidden.
    assert board.unrevealed_count() == 8

    # Reveal the numbered cells one by one; each is a single-cell reveal.
    board.reveal(2, 0)
    board.reveal(0, 1)
    board.reveal(2, 1)
    board.reveal(0, 2)
    board.reveal(2, 2)
    assert board.unrevealed_count() == 3
    assert board.status is GameStatus.PLAYING

    board.reveal(1, 0)
    board.reveal(1, 2)

    # Only the mine stays unrevealed, so the game is won.
    assert board.unrevealed_count() == 1
    assert board.status is GameStatus.WON


def test_snapshot_rows_are_tuples_of_cell_states():
    snapshot = MinesweeperGame(2, 2, [(0, 0)]).snapshot()

    assert snapshot.states == (
        (CellState.HIDDEN, CellState.HIDDEN),
        (CellState.HIDDEN, CellState.HIDDEN),
    )
    assert snapshot.adjacent_mines == ((0, 1), (1, 1))
