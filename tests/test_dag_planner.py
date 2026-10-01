"""Focused tests for the deterministic dependency DAG batch planner."""

from __future__ import annotations

import random

import pytest

from social_mcp.exercises.dag_planner import (
    DependencyPlannerError,
    DuplicateTaskError,
    SelfDependencyError,
    TaskCycleError,
    UnknownTaskError,
    plan_execution,
)

ACYCLIC = {
    "a": ["b", "c"],
    "b": ["d"],
    "c": ["d"],
    "d": [],
    "e": ["a"],
    "f": [],
}

CYCLIC = {"a": ["b"], "b": ["c"], "c": ["d"], "d": ["a"], "e": []}


def _shuffled(graph: "dict[str, list[str]]", seed: int) -> "dict[str, list[str]]":
    rng = random.Random(seed)
    keys = list(graph)
    rng.shuffle(keys)
    shuffled: "dict[str, list[str]]" = {}
    for key in keys:
        deps = list(graph[key])
        rng.shuffle(deps)
        shuffled[key] = deps
    return shuffled


def _assert_batches_are_valid(
    graph: "dict[str, list[str]]", batches: "list[list[str]]"
) -> None:
    """Every task appears once, batches are ordered, and dependencies precede them."""

    finished: set[str] = set()
    for batch in batches:
        assert batch == sorted(batch)
        assert len(set(batch)) == len(batch)
        for task in batch:
            for dependency in graph[task]:
                assert dependency in finished, f"{dependency!r} must precede {task!r}"
        finished.update(batch)
    assert finished == set(graph)


def test_empty_graph_returns_empty_plan() -> None:
    assert plan_execution({}) == []
    assert plan_execution([]) == []


def test_single_node_graph() -> None:
    assert plan_execution({"only": []}) == [["only"]]


def test_linear_chain_runs_dependencies_first() -> None:
    graph = {"a": ["b"], "b": ["c"], "c": []}
    assert plan_execution(graph) == [["c"], ["b"], ["a"]]


def test_diamond_dependency_graph() -> None:
    graph = {"d": ["b", "c"], "b": ["a"], "c": ["a"], "a": []}
    assert plan_execution(graph) == [["a"], ["b", "c"], ["d"]]


def test_disconnected_components_are_planned_together() -> None:
    graph = {"a": [], "b": ["a"], "x": [], "y": ["x", "z"], "z": []}
    assert plan_execution(graph) == [["a", "x", "z"], ["b", "y"]]


def test_batches_are_lexicographically_ordered() -> None:
    graph = {"z": [], "y": [], "m": [], "a": []}
    assert plan_execution(graph) == [["a", "m", "y", "z"]]


def test_repeated_dependencies_are_allowed() -> None:
    pairs = [("a", ["b", "b"]), ("b", [])]
    assert plan_execution(pairs) == [["b"], ["a"]]


def test_rejects_unknown_dependency() -> None:
    with pytest.raises(UnknownTaskError) as excinfo:
        plan_execution({"a": ["ghost"]})
    assert excinfo.value.dependency == "ghost"
    assert isinstance(excinfo.value, DependencyPlannerError)


def test_rejects_self_dependency() -> None:
    with pytest.raises(SelfDependencyError) as excinfo:
        plan_execution({"a": ["a"], "b": []})
    assert excinfo.value.task == "a"
    assert "itself" in str(excinfo.value)


def test_rejects_duplicate_task_definitions() -> None:
    pairs = [("a", []), ("b", []), ("a", ["b"])]
    with pytest.raises(DuplicateTaskError) as excinfo:
        plan_execution(pairs)
    assert excinfo.value.task == "a"


def test_detects_multi_node_cycle() -> None:
    graph = {"a": ["b"], "b": ["c"], "c": ["a"], "d": []}
    with pytest.raises(TaskCycleError) as excinfo:
        plan_execution(graph)
    error = excinfo.value
    assert error.path == ("a", "b", "c", "a")
    assert error.path_text == "a -> b -> c -> a"
    assert error.cycle == error.path_text
    assert isinstance(error, DependencyPlannerError)


def test_detects_cycle_beside_acyclic_components() -> None:
    graph = {"ok": [], "later": ["ok"], "x": ["y"], "y": ["z"], "z": ["x"]}
    with pytest.raises(TaskCycleError) as excinfo:
        plan_execution(graph)
    assert excinfo.value.path_text == "x -> y -> z -> x"


def test_batches_are_deterministic_across_shuffled_inputs() -> None:
    expected = [["d", "f"], ["b", "c"], ["a"], ["e"]]
    assert plan_execution(ACYCLIC) == expected
    for seed in range(12):
        shuffled = _shuffled(ACYCLIC, seed)
        assert plan_execution(shuffled) == expected
        _assert_batches_are_valid(ACYCLIC, plan_execution(shuffled))


def test_cycle_report_is_deterministic_across_shuffled_inputs() -> None:
    for seed in range(12):
        with pytest.raises(TaskCycleError) as excinfo:
            plan_execution(_shuffled(CYCLIC, seed))
        assert excinfo.value.path_text == "a -> b -> c -> d -> a"

    assert isinstance(excinfo.value, DependencyPlannerError)

