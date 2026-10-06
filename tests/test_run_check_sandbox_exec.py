"""Contract tests for the trusted sandbox process wrapper."""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[1] / "infra/github-runner-autoscaler/run-check-sandbox-exec.py"
SPEC = spec_from_file_location("run_check_sandbox_exec", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
SANDBOX_EXEC = module_from_spec(SPEC)
SPEC.loader.exec_module(SANDBOX_EXEC)


def test_sandbox_wrapper_accepts_every_v2_run_check_environment_key() -> None:
    environment = {
        "HOME": "/tmp",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "PI_TRUSTED_ACCEPTANCE_BASELINE_TARGETS": "",
        "PI_TRUSTED_ACCEPTANCE_TARGETS": "",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
        "TMPDIR": "/tmp",
    }

    SANDBOX_EXEC.validate_environment(environment)


def test_sandbox_wrapper_rejects_environment_keys_outside_its_allowlist() -> None:
    with pytest.raises(ValueError, match="invalid sandbox environment"):
        SANDBOX_EXEC.validate_environment({"GH_TOKEN": "must-not-enter-sandbox"})
