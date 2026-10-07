"""Run the trusted acceptance-boundary probes from ``manifest.json`` (#427).

These probes live outside the implementation-authored focused suites on
purpose: a passing generated suite must not imply the acceptance boundary is
covered. The directory is control-plane protected, so a candidate cannot weaken
or delete a probe to turn a failure into VERIFIED.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
from collections.abc import Iterable, Mapping
from copy import deepcopy
from datetime import datetime
from decimal import Decimal
from fractions import Fraction
from itertools import islice
from pathlib import Path
from typing import Any

import pytest

MANIFEST = json.loads((Path(__file__).parent / "manifest.json").read_text("utf-8"))
PROBES = MANIFEST["probes"]
CRITERIA = MANIFEST["criteria"]


def _decode(value):
    if isinstance(value, list):
        return [_decode(item) for item in value]
    if isinstance(value, dict):
        if "$float" in value:
            return float(value["$float"])
        if "$int" in value:
            return 10 ** int(value["$int"].split("e")[1])
        if "$datetime" in value:
            return datetime.fromisoformat(value["$datetime"])
        if "$decimal" in value:
            return Decimal(value["$decimal"])
        if "$fraction" in value:
            numerator, denominator = value["$fraction"]
            return Fraction(numerator, denominator)
        if "$tuple" in value:
            return tuple(_decode(item) for item in value["$tuple"])
        if "$iterator" in value:
            return iter(_decode(value["$iterator"]))
        return {key: _decode(item) for key, item in value.items()}
    return value


def _module_present(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ModuleNotFoundError, ValueError):
        return False


TRUSTED_TARGETS_ENV = "PI_TRUSTED_ACCEPTANCE_TARGETS"
TRUSTED_BASELINE_TARGETS_ENV = "PI_TRUSTED_ACCEPTANCE_BASELINE_TARGETS"


def _env_modules(name: str) -> set[str]:
    raw = os.environ.get(name)
    if raw is None:
        return set()
    return {item for item in raw.split(",") if item}


def _current_issue_requires(contract: dict) -> bool:
    module, _, _name = contract["target"].partition(":")
    if TRUSTED_TARGETS_ENV in os.environ:
        return module in _env_modules(TRUSTED_TARGETS_ENV)

    context_path = os.environ.get("PI_ISSUE_CONTEXT")
    if not context_path:
        return False
    try:
        context = json.loads(Path(context_path).read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        pytest.fail(f"trusted acceptance issue context is unreadable: {error}")
    marker = contract.get("issue_marker")
    return bool(marker and marker in {line.strip() for line in str(context.get("body", "")).splitlines()})


def _git_ref_exists(ref: str) -> bool:
    try:
        result = subprocess.run(
            ["git", "cat-file", "-e", f"{ref}^{{commit}}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return False
    return result.returncode == 0


def _git_ref_contains(ref: str, source_path: str) -> bool:
    try:
        result = subprocess.run(
            ["git", "cat-file", "-e", f"{ref}:{source_path}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return False
    return result.returncode == 0


def _trusted_baseline_requires(contract: dict) -> bool:
    module, _, _name = contract["target"].partition(":")
    if TRUSTED_BASELINE_TARGETS_ENV in os.environ:
        return module in _env_modules(TRUSTED_BASELINE_TARGETS_ENV)

    source_path = contract.get("source_path")
    if (
        source_path
        and os.environ.get("GITHUB_ACTIONS") == "true"
        and os.environ.get("GITHUB_EVENT_NAME") == "pull_request"
        and str(os.environ.get("GITHUB_REF", "")).startswith("refs/pull/")
    ):
        if not _git_ref_exists("HEAD^1"):
            pytest.fail("trusted acceptance PR baseline is unavailable: HEAD^1")
        return _git_ref_contains("HEAD^1", source_path)
    return False


def _target(criterion: str):
    contract = CRITERIA[criterion]
    module, _, name = contract["target"].partition(":")
    if contract.get("activation") == "when-target-present" and not _module_present(module):
        if _current_issue_requires(contract):
            pytest.fail(f"trusted acceptance target required by current issue is missing: {module}")
        if _trusted_baseline_requires(contract):
            pytest.fail(f"trusted acceptance target present at the trusted baseline is missing: {module}")
        pytest.skip(f"trusted acceptance target is not present in this candidate or trusted baseline: {module}")
    return getattr(importlib.import_module(module), name)


@pytest.mark.parametrize("probe", PROBES, ids=[p["id"] for p in PROBES])
def test_probe(probe) -> None:
    function = _target(probe["criterion"])
    args = [_decode(arg) for arg in probe["args"]]
    kwargs = _decode(probe.get("kwargs", {}))
    snapshot = deepcopy((args, kwargs)) if probe.get("input_unchanged") is True else None

    if "raises" in probe:
        with pytest.raises(ValueError):
            function(*args, **kwargs)
    elif probe.get("accepts") is True:
        function(*args, **kwargs)
    else:
        result = function(*args, **kwargs)
        assert result == _decode(probe["returns"])

    if snapshot is not None:
        assert (args, kwargs) == snapshot


def test_manifest_is_well_formed() -> None:
    ids = [probe["id"] for probe in PROBES]
    assert len(ids) == len(set(ids)), "probe ids must be unique"

    pack_targets = MANIFEST.get("smoke_pack_targets")
    assert isinstance(pack_targets, list) and len(pack_targets) == 8
    assert len(pack_targets) == len(set(pack_targets)), "smoke pack targets must be unique"

    for probe in PROBES:
        assert probe["criterion"] in CRITERIA, probe["id"]
        outcomes = sum(key in probe for key in ("raises", "returns", "accepts"))
        assert outcomes == 1, probe["id"]
        assert probe.get("raises", "ValueError") == "ValueError", probe["id"]
        assert isinstance(probe.get("kwargs", {}), dict), probe["id"]
        if "input_unchanged" in probe:
            assert probe["input_unchanged"] is True, probe["id"]
        if "accepts" in probe:
            assert probe["accepts"] is True, probe["id"]

    covered_targets = set()
    for name, criterion in CRITERIA.items():
        assert criterion["status"] and criterion["source"], name
        module, _, _symbol = criterion["target"].partition(":")
        assert module and _symbol, name
        covered_targets.add(module)
        if criterion.get("activation") == "when-target-present":
            assert criterion.get("issue_marker"), f"criterion {name} has no issue_marker"
            assert criterion.get("source_path"), f"criterion {name} has no source_path"
        assert any(p["criterion"] == name for p in PROBES), f"criterion {name} has no probe"

    missing = set(pack_targets) - covered_targets
    assert not missing, f"smoke pack targets without trusted criteria: {sorted(missing)}"


# Reference implementations copied from the accepted smoke implementations in
# PRs #409 (duration), #413 (chunking), and #414 (redaction). They intentionally
# live only in the protected oracle test so deferred manifest probes execute in
# ordinary CI even when the disposable production smoke modules are absent.
_REFERENCE_DURATION_PATTERN = re.compile(
    r"^(?P<number>\d+(?:\.\d+)?|\.\d+)\s*(?P<unit>ms|s|m|h)$"
)
_REFERENCE_UNIT_SECONDS = {"ms": 0.001, "s": 1.0, "m": 60.0, "h": 3600.0}


def _reference_parse_duration_seconds(value: str) -> float:
    if not isinstance(value, str):
        raise ValueError("duration must be a string")
    text = value.strip()
    if not text:
        raise ValueError("duration must not be empty")
    match = _REFERENCE_DURATION_PATTERN.match(text)
    if match is None:
        raise ValueError("invalid duration")
    number = float(match.group("number"))
    seconds = number * _REFERENCE_UNIT_SECONDS[match.group("unit")]
    if not math.isfinite(number) or not math.isfinite(seconds) or seconds < 0:
        raise ValueError("duration must be finite and non-negative")
    return seconds


def _reference_chunked(iterable: Iterable[Any], size: int) -> list[list[Any]]:
    if isinstance(size, bool) or not isinstance(size, int) or size < 1:
        raise ValueError("size must be a positive integer")
    iterator = iter(iterable)
    chunks = []
    while True:
        chunk = list(islice(iterator, size))
        if not chunk:
            return chunks
        chunks.append(chunk)


def _reference_redact_mapping(
    mapping: Mapping[str, Any],
    sensitive_keys: Iterable[str],
    *,
    replacement: str = "***",
) -> dict[str, Any]:
    lowered = {str(key).casefold() for key in sensitive_keys}

    def visit(value: Any) -> Any:
        if isinstance(value, Mapping):
            return {
                key: replacement if str(key).casefold() in lowered else visit(item)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [visit(item) for item in value]
        if isinstance(value, tuple):
            return tuple(visit(item) for item in value)
        return value

    return visit(mapping)


_REFERENCE_DEFERRED_TARGETS = {
    "duration-contract": _reference_parse_duration_seconds,
    "chunking-contract": _reference_chunked,
    "redaction-contract": _reference_redact_mapping,
}
_REFERENCE_DEFERRED_PROBES = [
    probe for probe in PROBES if probe["criterion"] in _REFERENCE_DEFERRED_TARGETS
]


@pytest.mark.parametrize(
    "probe",
    _REFERENCE_DEFERRED_PROBES,
    ids=[probe["id"] for probe in _REFERENCE_DEFERRED_PROBES],
)
def test_deferred_probe_against_accepted_reference_implementation(probe, monkeypatch) -> None:
    monkeypatch.setattr(
        sys.modules[__name__],
        "_target",
        lambda criterion: _REFERENCE_DEFERRED_TARGETS[criterion],
    )
    test_probe(probe)


def test_decode_preserves_lists_and_supports_explicit_tuple_and_iterator() -> None:
    assert _decode([1, 2]) == [1, 2]
    assert _decode({"$tuple": [1, 2]}) == (1, 2)

    iterator = _decode({"$iterator": [1, 2]})
    assert list(iterator) == [1, 2]
    assert list(iterator) == []


def test_probe_supports_kwargs_and_input_immutability(monkeypatch) -> None:
    def helper(mapping, *, replacement):
        return {"token": replacement, "safe": mapping["safe"]}

    monkeypatch.setattr(sys.modules[__name__], "_target", lambda _criterion: helper)
    test_probe({
        "criterion": "synthetic",
        "args": [{"token": "secret", "safe": "visible"}],
        "kwargs": {"replacement": "[redacted]"},
        "returns": {"token": "[redacted]", "safe": "visible"},
        "input_unchanged": True,
    })


def test_deferred_target_marker_exercises_the_missing_target_fail_path(tmp_path, monkeypatch) -> None:
    context = tmp_path / "issue.json"
    context.write_text(
        json.dumps({
            "body": (
                "Recreate the smoke contract.\n"
                "trusted-acceptance-target: social_mcp.diagnostics.smoke_lru\n"
            ),
        }),
        "utf-8",
    )
    monkeypatch.delenv(TRUSTED_TARGETS_ENV, raising=False)
    monkeypatch.setenv("PI_ISSUE_CONTEXT", str(context))
    monkeypatch.setattr(importlib.util, "find_spec", lambda _module: None)

    assert _current_issue_requires(CRITERIA["lru-capacity-integer"])
    with pytest.raises(pytest.fail.Exception, match="trusted acceptance target required"):
        _target("lru-capacity-integer")


def test_free_text_module_mentions_do_not_activate_deferred_targets(tmp_path, monkeypatch) -> None:
    context = tmp_path / "issue.json"
    context.write_text(
        json.dumps({
            "title": "Do not touch smoke_lru",
            "body": (
                "Do not touch social_mcp.diagnostics.smoke_lru.\n"
                "The old path was src/social_mcp/diagnostics/smoke_lru.py.\n"
            ),
        }),
        "utf-8",
    )
    monkeypatch.setenv("PI_ISSUE_CONTEXT", str(context))

    assert not _current_issue_requires(CRITERIA["lru-capacity-integer"])


def test_safe_target_environment_drives_missing_target_failure(monkeypatch) -> None:
    monkeypatch.delenv("PI_ISSUE_CONTEXT", raising=False)
    monkeypatch.setenv(TRUSTED_TARGETS_ENV, "social_mcp.diagnostics.smoke_lru")
    monkeypatch.setattr(importlib.util, "find_spec", lambda _module: None)

    with pytest.raises(pytest.fail.Exception, match="required by current issue"):
        _target("lru-capacity-integer")


def test_trusted_baseline_prevents_deletion_from_turning_into_skip(monkeypatch) -> None:
    monkeypatch.delenv("PI_ISSUE_CONTEXT", raising=False)
    monkeypatch.setenv(TRUSTED_TARGETS_ENV, "")
    monkeypatch.setenv(TRUSTED_BASELINE_TARGETS_ENV, "social_mcp.diagnostics.smoke_intervals")
    monkeypatch.setattr(importlib.util, "find_spec", lambda _module: None)

    with pytest.raises(pytest.fail.Exception, match="present at the trusted baseline"):
        _target("interval-numeric-domain")


def test_malformed_explicit_issue_context_fails_closed(tmp_path, monkeypatch) -> None:
    context = tmp_path / "issue.json"
    context.write_text("{not-json", "utf-8")
    monkeypatch.delenv(TRUSTED_TARGETS_ENV, raising=False)
    monkeypatch.setenv("PI_ISSUE_CONTEXT", str(context))

    with pytest.raises(pytest.fail.Exception, match="issue context is unreadable"):
        _current_issue_requires(CRITERIA["lru-capacity-integer"])


def test_pr_ci_fails_closed_when_trusted_baseline_parent_is_unavailable(monkeypatch) -> None:
    monkeypatch.delenv(TRUSTED_BASELINE_TARGETS_ENV, raising=False)
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
    monkeypatch.setenv("GITHUB_REF", "refs/pull/477/merge")
    monkeypatch.setattr(sys.modules[__name__], "_git_ref_exists", lambda _ref: False)

    with pytest.raises(pytest.fail.Exception, match="PR baseline is unavailable"):
        _trusted_baseline_requires(CRITERIA["lru-capacity-integer"])


def test_pr_ci_reads_merge_parent_for_trusted_baseline(monkeypatch) -> None:
    monkeypatch.delenv(TRUSTED_BASELINE_TARGETS_ENV, raising=False)
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
    monkeypatch.setenv("GITHUB_REF", "refs/pull/477/merge")
    monkeypatch.setattr(sys.modules[__name__], "_git_ref_exists", lambda _ref: True)
    monkeypatch.setattr(
        sys.modules[__name__],
        "_git_ref_contains",
        lambda ref, path: ref == "HEAD^1" and path == "src/social_mcp/diagnostics/smoke_lru.py",
    )

    assert _trusted_baseline_requires(CRITERIA["lru-capacity-integer"])


def test_missing_parent_package_is_treated_as_absent() -> None:
    assert not _module_present("definitely_missing_acceptance_probe_parent.child")
