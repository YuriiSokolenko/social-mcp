"""Focused coverage for the access-ordered cache diagnostics helper."""

import pytest

from social_mcp.diagnostics.smoke_access_cache import AccessCache


def test_put_then_get_returns_values_in_insertion_order() -> None:
    cache: AccessCache = AccessCache(capacity=3)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.put("c", 3)

    assert cache.get("a") == 1
    assert cache.get("b") == 2
    assert cache.get("c") == 3
    assert len(cache) == 3


def test_get_promotes_key_and_changes_eviction_order() -> None:
    cache: AccessCache = AccessCache(capacity=3)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.put("c", 3)

    assert cache.get("a") == 1

    cache.put("d", 4)

    assert "a" in cache
    assert "b" not in cache
    assert "c" in cache
    assert "d" in cache
    assert len(cache) == 3


def test_inserting_beyond_capacity_evicts_exactly_least_recently_used() -> None:
    cache: AccessCache = AccessCache(capacity=2)
    cache.put("a", 1)
    cache.put("b", 2)

    cache.put("c", 3)

    assert "a" not in cache
    assert "b" in cache
    assert "c" in cache
    assert len(cache) == 2


def test_membership_test_does_not_promote_key() -> None:
    cache: AccessCache = AccessCache(capacity=2)
    cache.put("a", 1)
    cache.put("b", 2)

    assert "a" in cache
    assert "z" not in cache

    cache.put("c", 3)

    assert "a" not in cache
    assert "b" in cache


def test_update_replaces_value_and_promotes_without_changing_size() -> None:
    cache: AccessCache = AccessCache(capacity=3)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.put("c", 3)

    cache.put("a", 99)

    assert len(cache) == 3
    assert cache.get("a") == 99

    cache.put("d", 4)

    assert "a" in cache
    assert "b" not in cache
    assert len(cache) == 3


def test_missing_key_returns_default_without_changing_state() -> None:
    cache: AccessCache = AccessCache(capacity=2)
    cache.put("a", 1)
    cache.put("b", 2)

    assert cache.get("missing") is None
    assert cache.get("missing", "fallback") == "fallback"
    assert len(cache) == 2

    cache.put("c", 3)

    assert "a" not in cache
    assert "b" in cache


def test_capacity_one_keeps_only_the_most_recent_entry() -> None:
    cache: AccessCache = AccessCache(capacity=1)
    cache.put("a", 1)

    assert len(cache) == 1
    assert cache.get("a") == 1

    cache.put("b", 2)

    assert len(cache) == 1
    assert "a" not in cache
    assert cache.get("b") == 2


def test_length_tracks_cached_entries() -> None:
    cache: AccessCache = AccessCache(capacity=4)
    assert len(cache) == 0

    cache.put("a", 1)
    assert len(cache) == 1

    cache.put("b", 2)
    cache.put("b", 3)
    assert len(cache) == 2

    cache.put("c", 4)
    cache.put("d", 5)
    cache.put("e", 6)
    assert len(cache) == 4


@pytest.mark.parametrize("capacity", [0, -1, 1.5, "3", None, True, False])
def test_invalid_capacity_raises_value_error(capacity: object) -> None:
    with pytest.raises(ValueError):
        AccessCache(capacity=capacity)


def test_does_not_mutate_caller_state() -> None:
    keys = ["a", "b", "c"]
    values = {"payload": [1, 2, 3]}
    cache: AccessCache = AccessCache(capacity=2)

    for key in keys:
        cache.put(key, values)

    assert cache.get("b") == {"payload": [1, 2, 3]}
    assert keys == ["a", "b", "c"]
    assert values == {"payload": [1, 2, 3]}
    assert cache.capacity == 2
