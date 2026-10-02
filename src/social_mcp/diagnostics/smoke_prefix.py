"""Reversible string prefix helpers for diagnostics smoke checks.

Standard library only. Both helpers are pure: they never mutate their input
list and always return a new list, preserving order.
"""

__all__ = ("add_prefix", "remove_prefix")


def add_prefix(values: list[str], prefix: str) -> list[str]:
    """Return a new list with ``prefix`` prepended to every value.

    Order is preserved and the input list is left untouched.
    """
    return [f"{prefix}{value}" for value in values]


def remove_prefix(values: list[str], prefix: str) -> list[str]:
    """Return a new list with one leading ``prefix`` removed per value.

    Exactly one leading occurrence is stripped from values that start with
    ``prefix``; values without it are left unchanged. An empty prefix leaves
    the string contents unchanged but still yields a new list.
    """
    if not prefix:
        return list(values)
    return [_strip_once(value, prefix) for value in values]


def _strip_once(value: str, prefix: str) -> str:
    if not value.startswith(prefix):
        return value
    return value[len(prefix) :]
