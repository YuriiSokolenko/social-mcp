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


def _target(criterion: str):
    contract = CRITERIA[criterion]
    module, _, name = contract["target"].partition(":")
    if contract.get("activation") == "when-target-present" and importlib.util.find_spec(module) is None:
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
