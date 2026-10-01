"""Deterministic dependency DAG batch planner.

Pure, stdlib-only graph helper: it validates a task DAG and computes execution
batches. It never executes tasks and performs no async scheduling.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence

__all__ = [
    "DependencyPlannerError",
    "DuplicateTaskError",
    "SelfDependencyError",
    "TaskCycleError",
    "UnknownTaskError",
    "plan_execution",
]

TaskGraph = "Mapping[str, str | Iterable[str]] | Sequence[tuple[str, str | Iterable[str]]]"


class DependencyPlannerError(Exception):
    """Base error for every dependency planner failure."""


class DuplicateTaskError(DependencyPlannerError):
    """Raised when a task identifier is defined more than once."""

    def __init__(self, task: str) -> None:
        self.task = task
        super().__init__(f"duplicate task definition: {task!r}")


class UnknownTaskError(DependencyPlannerError):
    """Raised when a dependency is not a declared task."""

    def __init__(self, task: str, dependency: str) -> None:
        self.task = task
        self.dependency = dependency
        super().__init__(
            f"task {task!r} depends on unknown task {dependency!r}"
        )


class SelfDependencyError(DependencyPlannerError):
    """Raised when a task declares itself as a dependency."""

    def __init__(self, task: str) -> None:
        self.task = task
        super().__init__(f"task {task!r} depends on itself")


class TaskCycleError(DependencyPlannerError):
    """Raised when the task graph contains a cycle.

    The error exposes one concrete closed cycle path, for example
    ``"a -> b -> c -> a"``, via :attr:`path`, :attr:`path_text` and
    :attr:`cycle`.
    """

    def __init__(self, path: Sequence[str]) -> None:
        self.path: tuple[str, ...] = tuple(path)
        self.path_text = " -> ".join(self.path)
        self.cycle = self.path_text
        super().__init__(f"task dependency cycle detected: {self.path_text}")


def _dependencies(deps: "str | Iterable[str]") -> "list[str]":
    if isinstance(deps, str):
        return [deps]
    return list(deps)


def _normalise(tasks: object) -> "dict[str, list[str]]":
    """Collect task definitions, rejecting duplicate identifiers."""

    entries = tasks.items() if isinstance(tasks, Mapping) else tasks

    graph: "dict[str, list[str]]" = {}
    for task, deps in entries:
        if task in graph:
            raise DuplicateTaskError(task)
        graph[task] = _dependencies(deps)
    return graph


def _edges(graph: "dict[str, list[str]]") -> "dict[str, list[str]]":
    """Validate dependencies and return deduplicated, sorted adjacency."""

    declared = set(graph)
    edges: "dict[str, list[str]]" = {}
    for task, deps in graph.items():
        for dependency in deps:
            if dependency == task:
                raise SelfDependencyError(task)
            if dependency not in declared:
                raise UnknownTaskError(task, dependency)
        edges[task] = sorted(set(deps))
    return edges


def _closed_cycle(path: "list[str]") -> "tuple[str, ...]":
    """Rotate an open cycle so the smallest identifier leads the path."""

    first = min(path)
    index = path.index(first)
    rotated = path[index:] + path[:index]
    return tuple([*rotated, first])


def _find_cycle(
    nodes: "list[str]", edges: "dict[str, list[str]]"
) -> "tuple[str, ...] | None":
    """Return one deterministic closed cycle path, or ``None`` if acyclic."""

    settled: set[str] = set()
    trail: list[str] = []
    on_trail: set[str] = set()

    def visit(node: str) -> "tuple[str, ...] | None":
        if node in on_trail:
            return _closed_cycle(trail[trail.index(node) :])
        if node in settled:
            return None
        trail.append(node)
        on_trail.add(node)
        for dependency in edges[node]:
            found = visit(dependency)
            if found is not None:
                return found
        trail.pop()
        on_trail.discard(node)
        settled.add(node)
        return None

    for node in sorted(nodes):
        cycle = visit(node)
        if cycle is not None:
            return cycle
    return None


def _levels(
    nodes: "list[str]", edges: "dict[str, list[str]]"
) -> "dict[str, int]":
    """Depth of each task: one more than the depth of its deepest dependency."""

    depth: dict[str, int] = {}

    def level(node: str) -> int:
        cached = depth.get(node)
        if cached is not None:
            return cached
        deepest = (level(dependency) for dependency in edges[node])
        value = 1 + max(deepest, default=-1)
        depth[node] = value
        return value

    for node in sorted(nodes):
        level(node)
    return depth


def plan_execution(tasks: TaskGraph) -> "list[list[str]]":
    """Return deterministic execution batches for a task graph.

    Each batch holds tasks that may run concurrently, and every dependency of a
    task lives in an earlier batch. Batch content is lexicographically ordered
    and independent of the order of the input.

    Args:
        tasks: Mapping of task identifier to dependencies, or a sequence of
            ``(task, dependencies)`` pairs.

    Returns:
        Ordered batches; empty when the input graph is empty.

    Raises:
        DuplicateTaskError: A task identifier is declared more than once.
        UnknownTaskError: A dependency is not a declared task.
        SelfDependencyError: A task declares itself as a dependency.
        TaskCycleError: The graph contains a cycle.
    """

    edges = _edges(_normalise(tasks))
    nodes = sorted(edges)

    cycle = _find_cycle(nodes, edges)
    if cycle is not None:
        raise TaskCycleError(cycle)

    depth = _levels(nodes, edges)
    batches: dict[int, list[str]] = {}
    for node in nodes:
        batches.setdefault(depth[node], []).append(node)
    return [batches[level] for level in sorted(batches)]