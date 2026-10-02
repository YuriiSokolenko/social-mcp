"""Focused coverage for the diagnostics smoke prefix helpers."""

import pytest

from social_mcp.diagnostics.smoke_prefix import add_prefix, remove_prefix


class TestAddPrefix:
    def test_prepends_prefix_to_every_value(self):
        assert add_prefix(["a", "b"], "p-") == ["p-a", "p-b"]

    def test_returns_new_list_and_leaves_input_untouched(self):
        values = ["a"]
        result = add_prefix(values, "p-")

        assert result is not values
        assert values == ["a"]

    def test_empty_prefix_leaves_contents_unchanged_but_returns_new_list(self):
        values = ["a", "b"]
        result = add_prefix(values, "")

        assert result == ["a", "b"]
        assert result is not values

    def test_preserves_order(self):
        assert add_prefix(["c", "a", "b"], "x") == ["xc", "xa", "xb"]

    def test_empty_input_returns_empty_list(self):
        result = add_prefix([], "p-")

        assert result == []
        assert isinstance(result, list)

    def test_repeated_application_stacks_prefix(self):
        assert add_prefix(add_prefix(["a"], "p-"), "p-") == ["p-p-a"]


class TestRemovePrefix:
    def test_removes_exactly_one_leading_occurrence(self):
        assert remove_prefix(["p-p-a"], "p-") == ["p-a"]

    def test_leaves_unprefixed_values_unchanged(self):
        assert remove_prefix(["q-a", "p-b"], "p-") == ["q-a", "b"]

    def test_returns_new_list_and_leaves_input_untouched(self):
        values = ["p-a"]
        result = remove_prefix(values, "p-")

        assert result is not values
        assert values == ["p-a"]

    def test_empty_prefix_leaves_contents_unchanged_but_returns_new_list(self):
        values = ["a", "b"]
        result = remove_prefix(values, "")

        assert result == ["a", "b"]
        assert result is not values

    def test_preserves_order(self):
        assert remove_prefix(["p-c", "p-a", "p-b"], "p-") == ["c", "a", "b"]

    def test_empty_input_returns_empty_list(self):
        result = remove_prefix([], "p-")

        assert result == []
        assert isinstance(result, list)

    def test_value_equal_to_prefix_becomes_empty_string(self):
        assert remove_prefix(["p-"], "p-") == [""]


def test_round_trip_is_reversible():
    values = ["alpha", "beta", "gamma"]
    prefixed = add_prefix(values, "~")

    assert prefixed == ["~alpha", "~beta", "~gamma"]
    assert remove_prefix(prefixed, "~") == values

    # Non-matching values are untouched, so the mapping stays lossless for them.
    mixed = add_prefix(["keep"], "~")
    assert remove_prefix(["keep"], "~") == ["keep"]
    assert mixed == ["~keep"]


@pytest.mark.parametrize("value", ["", "already", "-prefixed"])
def test_remove_prefix_is_identity_for_absent_prefix(value):
    assert remove_prefix([value], "p-") == [value]
