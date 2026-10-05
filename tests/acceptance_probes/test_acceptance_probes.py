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
import os
import subprocess
from datetime import datetime
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

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
            ["git", "cat-file", "-e", f"{ref}^{commit}"],
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
    if "raises" in probe:
        with pytest.raises(ValueError):
            function(*args)
    elif probe.get("accepts") is True:
        function(*args)
    else:
        result = function(*args)
        assert result == (tuple(probe["returns"]) if isinstance(probe["returns"], list) else probe["returns"])


def test_manifest_is_well_formed() -> None:
    ids = [probe["id"] for probe in PROBES]
    assert len(ids) == len(set(ids)), "probe ids must be unique"
    for probe in PROBES:
        assert probe["criterion"] in CRITERIA, probe["id"]
        outcomes = sum(key in probe for key in ("raises", "returns", "accepts"))
        assert outcomes == 1, probe["id"]
        assert probe.get("raises", "ValueError") == "ValueError", probe["id"]
        if "accepts" in probe:
            assert probe["accepts"] is True, probe["id"]
    for name, criterion in CRITERIA.items():
        assert criterion["status"] and criterion["source"], name
        if criterion.get("activation") == "when-target-present":
            assert criterion.get("issue_marker"), f"criterion {name} has no issue_marker"
            assert criterion.get("source_path"), f"criterion {name} has no source_path"
        assert any(p["criterion"] == name for p in PROBES), f"criterion {name} has no probe"


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
    monkeypatch.setattr(__import__(__name__), "_git_ref_exists", lambda _ref: False)

    with pytest.raises(pytest.fail.Exception, match="PR baseline is unavailable"):
        _trusted_baseline_requires(CRITERIA["lru-capacity-integer"])


def test_pr_ci_reads_merge_parent_for_trusted_baseline(monkeypatch) -> None:
    monkeypatch.delenv(TRUSTED_BASELINE_TARGETS_ENV, raising=False)
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
    monkeypatch.setenv("GITHUB_REF", "refs/pull/477/merge")
    monkeypatch.setattr(__import__(__name__), "_git_ref_exists", lambda _ref: True)
    monkeypatch.setattr(
        __import__(__name__),
        "_git_ref_contains",
        lambda ref, path: ref == "HEAD^1" and path == "src/social_mcp/diagnostics/smoke_lru.py",
    )

    assert _trusted_baseline_requires(CRITERIA["lru-capacity-integer"])


def test_missing_parent_package_is_treated_as_absent() -> None:
    assert not _module_present("definitely_missing_acceptance_probe_parent.child")
