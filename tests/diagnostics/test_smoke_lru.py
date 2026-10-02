"""Focused coverage for the bounded LRU cache diagnostics helper."""

import pytest

from social_mcp.diagnostics.smoke_lru import LRUCache


def test_put_and_get_round_trip_and_membership():
    cache: LRUCache = LRUCache(capacity=2)

    assert len(cache) == 0
    assert "missing" not in cache

    cache.put("a", 1)
    cache.put("b", 2)

    assert len(cache) == 2
    assert "a" in cache
    assert "b" in cache
    assert cache.get("a") == 1


def test_get_promotes_key_to_most_recently_used():
    cache: LRUCache = LRUCache(capacity=2)
    cache.put("a", 1)
    cache.put("b", 2)

    assert cache.get("a") == 1
    # "a" was accessed last, so inserting a third key evicts "b".
    cache.put("c", 3)

    assert len(cache) == 2
    assert "a" in cache
    assert "b" not in cache
    assert "c" in cache
    assert list(iter(cache)) == ["a", "c"]


def test_insert_beyond_capacity_evicts_exactly_least_recently_used():
    cache: LRUCache = LRUCache(capacity=3)
    for key, value in (("a", 1), ("b", 2), ("c", 3)):
        cache.put(key, value)

    assert len(cache) == 3

    cache.put("d", 4)

    assert len(cache) == 3
    assert "a" not in cache
    assert list(iter(cache)) == ["b", "c", "d"]


def test_update_replaces_value_and_promotes_without_growing():
    cache: LRUCache = LRUCache(capacity=2)
    cache.put("a", 1)
    cache.put("b", 2)

    cache.put("a", 99)

    assert len(cache) == 2
    assert cache.get("a") == 99
    assert list(iter(cache)) == ["b", "a"]

    cache.put("c", 3)

    assert len(cache) == 2
    assert "b" not in cache
    assert "a" in cache
    assert "c" in cache


def test_missing_keys_return_defaults_without_touching_state():
    cache: LRUCache = LRUCache(capacity=2)
    cache.put("a", 1)

    assert cache.get("missing") is None
    assert cache.get("missing", "fallback") == "fallback"
    assert len(cache) == 1
    assert list(iter(cache)) == ["a"]


def test_capacity_one_keeps_only_the_newest_entry():
    cache: LRUCache = LRUCache(capacity=1)

    cache.put("a", 1)
    assert len(cache) == 1

    cache.put("b", 2)

    assert len(cache) == 1
    assert "a" not in cache
    assert cache.get("b") == 2


@pytest.mark.parametrize("capacity", [0, -1, -100])
def test_non_positive_capacity_raises_value_error(capacity: int):
    with pytest.raises(ValueError):
        LRUCache(capacity=capacity)


@pytest.mark.parametrize("capacity", [True, False])
def test_boolean_capacity_raises_value_error(capacity: bool):
    with pytest.raises(ValueError):
        LRUCache(capacity=capacity)


@pytest.mark.parametrize("capacity", ["3", 3.0, None, [3]])
def test_non_integer_capacity_raises_value_error(capacity: object):
    with pytest.raises(ValueError):
        LRUCache(capacity=capacity)  # type: ignore[arg-type]
