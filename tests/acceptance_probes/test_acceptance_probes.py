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
import re
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


ISSUE_TARGET_MARKER = re.compile(
    r"^\s*(?:[-*]\s*)?trusted-acceptance-target\s*:\s*(\S+)\s*$",
    re.IGNORECASE,
)


def _current_issue_requires(module: str) -> bool:
    context_path = os.environ.get("PI_ISSUE_CONTEXT")
    if not context_path:
        return False
    try:
        context = json.loads(Path(context_path).read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    for line in str(context.get("body", "")).splitlines():
        match = ISSUE_TARGET_MARKER.match(line)
        if match and match.group(1) == module:
            return True
    return False


def _target(criterion: str):
    contract = CRITERIA[criterion]
    module, _, name = contract["target"].partition(":")
    if contract.get("activation") == "when-target-present" and not _module_present(module):
        if _current_issue_requires(module):
            pytest.fail(f"trusted acceptance target required by current issue is missing: {module}")
        pytest.skip(f"trusted acceptance target is not present in this candidate: {module}")
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

    assert _current_issue_requires("social_mcp.diagnostics.smoke_lru")
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

    assert not _current_issue_requires("social_mcp.diagnostics.smoke_lru")


def test_missing_parent_package_is_treated_as_absent() -> None:
    assert not _module_present("definitely_missing_acceptance_probe_parent.child")
