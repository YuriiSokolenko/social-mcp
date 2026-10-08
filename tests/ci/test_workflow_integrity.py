"""Static CI surface contract: all committed workflows must parse and resolve dependencies."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIR = ROOT / ".github" / "workflows"
SCRIPT_REF = re.compile(r"(?<![\w.])scripts/[a-zA-Z0-9_./-]+\.(?:mjs|py|sh)\b")
ACTION_REF = re.compile(r"^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+@(?:v[1-9]\d*|[0-9a-f]{40})$")
CONTROL_JOBS = {
    ("ci.yml", "wake-merge-gate"),
    ("ci-terminal-wake.yml", "wake-pr-merge-gate"),
    ("pi-automation-control.yml", "control"),
}
RUNNER_POOLS = {
    ("self-hosted", "linux", "x64", "n150", "pi-agent"),
    ("self-hosted", "linux", "x64", "n150", "general"),
    ("self-hosted", "n150", "control"),
}


def workflows():
    paths = sorted((*WORKFLOW_DIR.glob("*.yml"), *WORKFLOW_DIR.glob("*.yaml")))
    assert paths, "No GitHub workflows found"
    parsed = {}
    for path in paths:
        # BaseLoader preserves the GitHub Actions 'on' key (YAML 1.1 SafeLoader
        # would silently convert it to the boolean True).
        document = yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
        assert isinstance(document, dict), f"{path}: expected YAML mapping"
        assert isinstance(document.get("on"), dict), f"{path}: no valid trigger mapping"
        assert isinstance(document.get("jobs"), dict) and document["jobs"], f"{path}: no jobs"
        assert isinstance(document.get("name"), str), f"{path}: no workflow name"
        parsed[path.name] = document
    return parsed


def test_workflow_graph_and_local_references():
    documents = workflows()
    names = {document["name"] for document in documents.values()}
    found_control = set()

    for filename, workflow in documents.items():
        triggers = workflow["on"]
        if "workflow_run" in triggers:
            for source in triggers["workflow_run"]["workflows"]:
                assert source in names, f"{filename}: unknown workflow_run source {source}"

        jobs = workflow["jobs"]
        for job_name, job in jobs.items():
            assert isinstance(job, dict), f"{filename}/{job_name}: invalid job"
            dependencies = job.get("needs", [])
            if isinstance(dependencies, str):
                dependencies = [dependencies]
            for dependency in dependencies:
                assert dependency in jobs, f"{filename}/{job_name}: unknown need {dependency}"
                assert dependency != job_name, f"{filename}/{job_name}: self-dependency"

            runner = job.get("runs-on")
            assert runner, f"{filename}/{job_name}: no runner"
            if isinstance(runner, list):
                labels = tuple(runner)
                assert labels in RUNNER_POOLS, f"{filename}/{job_name}: unrecognized runner labels: {labels}"
                if "control" in labels:
                    assert (filename, job_name) in CONTROL_JOBS, (
                        f"{filename}/{job_name}: unapproved control-lane job"
                    )
                    found_control.add((filename, job_name))
            else:
                assert runner == "ubuntu-latest", f"{filename}/{job_name}: unknown hosted runner {runner}"

            steps = job.get("steps", [])
            assert isinstance(steps, list) and steps, f"{filename}/{job_name}: no steps"
            for step in steps:
                assert isinstance(step, dict), f"{filename}/{job_name}: malformed step"
                action = step.get("uses")
                if action:
                    if action.startswith("./"):
                        assert (ROOT / action).exists(), f"{filename}: missing local action {action}"
                    else:
                        assert ACTION_REF.fullmatch(action), f"{filename}: unpinned action {action}"
                for reference in SCRIPT_REF.findall(str(step.get("run", ""))):
                    assert (ROOT / reference).is_file(), (
                        f"{filename}/{job_name}: missing local script {reference}"
                    )

    assert found_control == CONTROL_JOBS, "A required bounded control-lane job moved or disappeared"


@pytest.mark.parametrize("file_name", ["pi-automation-control.yml", "pi-usage.yml"])
def test_privileged_entry_points_use_trusted_dev(file_name):
    document = workflows()[file_name]
    checkouts = [
        step
        for job in document["jobs"].values()
        for step in job.get("steps", [])
        if str(step.get("uses", "")).startswith("actions/checkout@")
    ]
    assert checkouts, f"{file_name}: no trusted checkout"
    for step in checkouts:
        options = step.get("with", {})
        assert options.get("ref") == "dev", f"{file_name}: untrusted checkout ref"
        assert options.get("persist-credentials") == "false", (
            f"{file_name}: checkout must not persist job token"
        )

def test_ci_pr_validation_uses_event_revision_and_post_dev_wake_uses_trusted_dev():
    jobs = workflows()["ci.yml"]["jobs"]
    for job_name in ("test", "docker"):
        checkout = next(step for step in jobs[job_name]["steps"] if step.get("uses", "").startswith("actions/checkout@"))
        assert "ref" not in checkout.get("with", {}), f"{job_name}: PR checks must test the event commit"
        assert checkout["with"]["persist-credentials"] == "false"
    wake = next(step for step in jobs["wake-merge-gate"]["steps"] if step.get("uses", "").startswith("actions/checkout@"))
    assert wake["with"]["ref"] == "dev"
    assert wake["with"]["persist-credentials"] == "false"
