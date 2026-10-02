"""Focused coverage for the bounded LRU cache smoke module."""

import pytest

from social_mcp.diagnostics.smoke_lru import LRUCache


def test_len_and_membership_report_cache_state():
    cache = LRUCache(3)
    assert len(cache) == 0
    assert "missing" not in cache

    cache.put("a", 1)
    assert len(cache) == 1
    assert "a" in cache
    assert "missing" not in cache


def test_get_returns_values_and_default_for_missing_keys():
    cache = LRUCache(2)
    cache.put("a", 1)

    assert cache.get("a") == 1
    assert cache.get("missing") is None
    assert cache.get("missing", "fallback") == "fallback"
    assert len(cache) == 1
    assert "missing" not in cache


def test_access_promotes_key_to_most_recently_used():
    cache = LRUCache(2)
    cache.put("a", 1)
    cache.put("b", 2)

    assert cache.get("a") == 1
    assert cache.keys() == ["b", "a"]

    # "b" is now the least-recently used entry and must be the one evicted.
    cache.put("c", 3)
    assert cache.keys() == ["a", "c"]
    assert "b" not in cache
    assert len(cache) == 2


def test_eviction_removes_exactly_the_least_recently_used_key():
    cache = LRUCache(3)
    for key, value in (("a", 1), ("b", 2), ("c", 3)):
        cache.put(key, value)

    assert cache.keys() == ["a", "b", "c"]

    cache.put("d", 4)
    assert "a" not in cache
    assert "b" in cache
    assert "c" in cache
    assert "d" in cache
    assert cache.keys() == ["b", "c", "d"]
    assert len(cache) == 3


def test_update_replaces_value_and_promotes_without_changing_size():
    cache = LRUCache(2)
    cache.put("a", 1)
    cache.put("b", 2)

    cache.put("a", 99)

    assert len(cache) == 2
    assert cache.get("a") == 99
    assert cache.keys() == ["b", "a"]


def test_capacity_one_keeps_only_the_newest_key():
    cache = LRUCache(1)
    cache.put("a", 1)
    assert len(cache) == 1

    cache.put("b", 2)
    assert len(cache) == 1
    assert "a" not in cache
    assert cache.get("b") == 2

    # Accessing the only key keeps it alive.
    cache.put("b", 3)
    assert cache.get("b") == 3
    assert len(cache) == 1


@pytest.mark.parametrize("capacity", [0, -1, -100])
def test_rejects_non_positive_capacity(capacity):
    with pytest.raises(ValueError):
        LRUCache(capacity)


@pytest.mark.parametrize("capacity", [None, 1.5, "3", [1]])
def test_rejects_non_integer_capacity(capacity):
    with pytest.raises(ValueError):
        LRUCache(capacity)


def test_capacity_property_is_readonly():
    cache = LRUCache(2)
    assert cache.capacity == 2
    cache.put("a", 1)
    assert cache.capacity == 2
