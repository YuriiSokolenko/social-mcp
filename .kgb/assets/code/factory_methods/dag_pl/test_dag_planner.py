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


def _flatten(batches: list[list[str]]) -> list[str]:
    return [task for batch in batches for task in batch]


def _assert_batches_are_valid(tasks: dict[str, list[str]], batches: list[list[str]]) -> None:
    """Every task appears once and every dependency precedes its dependant."""

    finished: set[str] = set()
    for batch in batches:
        assert batch == sorted(batch)
        assert len(set(batch)) == len(batch)
        for task in batch:
            for dep in tasks[task]:
                assert dep in finished, f"{dep!r} must precede {task!r}"
        finished.update(batch)
    assert finished == set(tasks)


def test_empty_graph_returns_empty_plan() -> None:
    assert plan_execution({}) == []


def test_single_node_graph() -> None:
    assert plan_execution({"a": []}) == [["a"]]


def test_linear_chain_is_one_task_per_batch() -> None:
    batches = plan_execution({"c": ["b"], "b": ["a"], "a": []})
    assert batches == [["a"], ["b"], ["c"]]


def test_diamond_graph() -> None:
    tasks = {"top": ["left", "right"], "left": ["base"], "right": ["base"], "base": []}
    batches = plan_execution(tasks)
    assert batches == [["base"], ["left", "right"], ["top"]]
    _assert_batches_are_valid(tasks, batches)


def test_disconnected_components_are_both_planned() -> None:
    tasks = {"b": ["a"], "a": [], "d": ["c"], "c": []}
    batches = plan_execution(tasks)
    assert batches == [["a", "c"], ["b", "d"]]
    _assert_batches_are_valid(tasks, batches)


def test_tasks_without_dependencies_share_the_first_batch() -> None:
    batches = plan_execution({"a": [], "b": [], "c": ["a", "b"]})
    assert batches == [["a", "b"], ["c"]]


def test_duplicate_task_definitions_are_rejected() -> None:
    with pytest.raises(DuplicateTaskError) as excinfo:
        plan_execution([("a", []), ("a", ["b"]), ("b", [])])
    assert excinfo.value.task == "a"
    assert isinstance(excinfo.value, DependencyPlannerError)


def test_pairs_input_matches_mapping_input() -> None:
    pairs = [("b", ["a"]), ("a", [])]
    assert plan_execution(pairs) == plan_execution(dict(pairs))


def test_unknown_dependency_is_rejected() -> None:
    with pytest.raises(UnknownTaskError) as excinfo:
        plan_execution({"a": ["ghost"]})
    assert (excinfo.value.task, excinfo.value.dependency) == ("a", "ghost")


def test_self_dependency_is_rejected() -> None:
    with pytest.raises(SelfDependencyError) as excinfo:
        plan_execution({"a": ["a"]})
    assert excinfo.value.task == "a"


def test_multi_node_cycle_reports_closed_path() -> None:
    with pytest.raises(TaskCycleError) as excinfo:
        plan_execution({"a": ["c"], "b": ["a"], "c": ["b"]})
    assert excinfo.value.path_text == "a -> c -> b -> a"
    assert excinfo.value.path[0] == excinfo.value.path[-1]


def test_cycle_in_one_component_is_reported_even_with_acyclic_peers() -> None:
    tasks = {"x": ["w"], "w": [], "b": ["a"], "a": ["b"]}
    with pytest.raises(TaskCycleError) as excinfo:
        plan_execution(tasks)
    assert excinfo.value.path_text == "a -> b -> a"


def test_batch_output_is_stable_across_shuffled_inputs() -> None:
    tasks = {
        "build": {"lint", "fetch"},
        "fetch": set(),
        "lint": set(),
        "publish": {"build"},
        "extra": set(),
        "other": {"other2"},
        "other2": set(),
    }
    expected = [
        ["extra", "fetch", "lint", "other2"],
        ["build", "other"],
        ["publish"],
    ]

    shuffle = {k: sorted(v) for k, v in tasks.items()}
    for seed in range(5):
        items = list(shuffle.items())
        random.Random(seed).shuffle(items)
        batches = plan_execution(items)
        assert batches == expected
        _assert_batches_are_valid({k: sorted(v) for k, v in tasks.items()}, batches)


def test_cycle_report_is_stable_across_shuffled_inputs() -> None:
    tasks = {"a": ["d"], "b": ["a"], "c": ["b"], "d": ["c"], "e": []}
    reports: set[str] = set()
    for seed in range(5):
        items = list(tasks.items())
        random.Random(seed).shuffle(items)
        with pytest.raises(TaskCycleError) as excinfo:
            plan_execution(items)
        reports.add(excinfo.value.path_text)
    assert reports == {"a -> d -> c -> b -> a"}


def test_string_dependencies_are_supported() -> None:
    assert plan_execution({"b": "a", "a": []}) == [["a"], ["b"]]


def test_repeated_dependencies_do_not_duplicate_tasks() -> None:
    assert plan_execution({"b": ["a", "a"], "a": []}) == [["a"], ["b"]]
