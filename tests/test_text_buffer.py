"""Focused tests for the reversible text buffer exercise."""

import pytest

from social_mcp.exercises.text_buffer import (
    EmptyHistoryError,
    NoOpEditError,
    TextBuffer,
)


class TestBasicEdits:
    def test_insert(self):
        buf = TextBuffer("ac")
        buf.insert(1, "b")
        assert buf.text == "abc"

    def test_insert_at_bounds(self):
        buf = TextBuffer("bc")
        buf.insert(0, "a")
        buf.insert(3, "d")
        assert buf.text == "abcd"

    def test_delete_returns_removed_text(self):
        buf = TextBuffer("abcdef")
        assert buf.delete(1, 4) == "bcd"
        assert buf.text == "aef"

    def test_replace_returns_old_text(self):
        buf = TextBuffer("hello world")
        assert buf.replace(6, 11, "pi") == "world"
        assert buf.text == "hello pi"


class TestUnicode:
    def test_offsets_are_characters_not_bytes(self):
        buf = TextBuffer("日本語")
        buf.insert(0, "本")
        assert buf.text == "本日本語"
        buf.delete(0, 1)
        assert buf.text == "日本語"
        assert buf.replace(0, 2, "🙂") == "日本"
        assert buf.text == "🙂語"

    def test_emoji_undoes_exactly(self):
        buf = TextBuffer("a😀b")
        buf.insert(2, "🎉")
        buf.undo()
        assert buf.text == "a😀b"
        buf.redo()
        assert buf.text == "a😀🎉b"


class TestInvalidArguments:
    def test_offset_out_of_range_leaves_state_untouched(self):
        buf = TextBuffer("abc")
        with pytest.raises(ValueError):
            buf.insert(4, "x")
        with pytest.raises(ValueError):
            buf.insert(-1, "x")
        assert buf.text == "abc"
        assert not buf.can_undo

    def test_inverted_range_rejected(self):
        buf = TextBuffer("abc")
        with pytest.raises(ValueError):
            buf.delete(3, 1)
        assert buf.text == "abc"
        assert not buf.can_undo

    def test_non_integer_offsets_rejected(self):
        buf = TextBuffer("abc")
        with pytest.raises(TypeError):
            buf.insert(1.5, "x")  # type: ignore[arg-type]
        with pytest.raises(TypeError):
            buf.replace("0", 1, "x")  # type: ignore[arg-type]
        assert buf.text == "abc"
        assert not buf.can_undo

    def test_invalid_history_limit(self):
        with pytest.raises(ValueError):
            TextBuffer("", history_limit=0)
        with pytest.raises(TypeError):
            TextBuffer("", history_limit=None)  # type: ignore[arg-type]


class TestHistory:
    def test_multiple_undo_redo_steps(self):
        buf = TextBuffer("")
        buf.insert(0, "a")
        buf.insert(1, "b")
        buf.insert(2, "c")
        assert buf.text == "abc"
        buf.undo()
        buf.undo()
        assert buf.text == "a"
        assert buf.can_redo
        buf.redo()
        assert buf.text == "ab"
        buf.redo()
        assert buf.text == "abc"
        assert not buf.can_redo
        assert buf.can_undo

    def test_divergent_edit_clears_redo(self):
        buf = TextBuffer("abc")
        buf.insert(3, "d")  # abcd
        buf.undo()  # abc, redo branch exists
        assert buf.can_redo
        buf.insert(0, "z")  # divergent edit
        assert not buf.can_redo
        with pytest.raises(EmptyHistoryError):
            buf.redo()

    def test_empty_branch_errors(self):
        buf = TextBuffer("abc")
        with pytest.raises(EmptyHistoryError):
            buf.undo()
        with pytest.raises(EmptyHistoryError):
            buf.redo()

    def test_history_limit_evicts_oldest(self):
        buf = TextBuffer("", history_limit=3)
        for ch in "abcde":
            buf.insert(len(buf.text), ch)
        assert buf.text == "abcde"
        assert buf.history_size == 3
        buf.undo()
        buf.undo()
        buf.undo()
        # Only the three most recent edits were undoable.
        assert buf.text == "ab"
        assert not buf.can_undo

    def test_history_limit_one(self):
        buf = TextBuffer("x", history_limit=1)
        buf.insert(1, "y")
        buf.insert(2, "z")
        assert buf.history_size == 1
        buf.undo()
        assert buf.text == "xy"
        assert not buf.can_undo


class TestNoOpEdits:
    def test_no_ops_raise_and_create_no_history(self):
        buf = TextBuffer("abc")
        with pytest.raises(NoOpEditError):
            buf.insert(1, "")
        with pytest.raises(NoOpEditError):
            buf.delete(2, 2)
        with pytest.raises(NoOpEditError):
            buf.replace(1, 2, "b")  # same text
        assert buf.text == "abc"
        assert not buf.can_undo
        assert buf.history_size == 0

    def test_no_op_does_not_clear_redo_branch(self):
        buf = TextBuffer("abc")
        buf.insert(3, "d")
        buf.undo()
        assert buf.can_redo
        with pytest.raises(NoOpEditError):
            buf.insert(0, "")
        assert buf.can_redo
        buf.redo()
        assert buf.text == "abcd"

    def test_no_op_is_also_a_value_error(self):
        buf = TextBuffer("abc")
        with pytest.raises(ValueError):
            buf.delete(1, 1)


class TestExactRestoration:
    def test_overlapping_edits_restore_exactly(self):
        original = "the quick brown fox"
        buf = TextBuffer(original)
        buf.replace(4, 9, "slow")  # "the slow brown fox"
        buf.delete(0, 4)  # "slow brown fox"
        buf.replace(11, 14, "cat")  # overlaps the earlier replace's region
        assert buf.text == "slow brown cat"
        buf.undo()
        buf.undo()
        buf.undo()
        assert buf.text == original
        assert not buf.can_undo
        buf.redo()
        buf.redo()
        buf.redo()
        assert buf.text == "slow brown cat"

    def test_undo_redo_preserves_unicode_exactly(self):
        original = "Ünïcödé ✓"
        buf = TextBuffer(original)
        buf.replace(0, len(original), "変更")
        buf.undo()
        assert buf.text == original
