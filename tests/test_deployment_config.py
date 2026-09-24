"""Structural tests for the Docker deployment configuration.

These tests validate the deployment contracts from issue #8 (Docker deployment on
N150) without requiring a Docker daemon:

- secrets are kept outside the image (interpolated from the host, never baked in),
- the token encryption key is a required runtime value, not a checked-in default,
- persistent account/token storage is a named volume,
- the service exposes a healthcheck probing /health,
- the README and deployment docs describe the strategy.

They guard the shape that the CI docker job and human deployments rely on.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
COMPOSE_FILE = ROOT / "compose.yaml"
DOCKERFILE = ROOT / "Dockerfile"
DEPLOY_DOC = ROOT / "docs" / "deploy.md"
README = ROOT / "README.md"
ENV_EXAMPLE = ROOT / ".env.example"
GITIGNORE = ROOT / ".gitignore"


def dockerfile_text() -> str:
    return DOCKERFILE.read_text()


@pytest.fixture(scope="module")
def compose() -> dict:
    with COMPOSE_FILE.open() as handle:
        return yaml.safe_load(handle)


def test_compose_has_single_app_service(compose: dict) -> None:
    services = compose["services"]
    assert list(services) == ["app"]


def test_app_builds_from_repository_root(compose: dict) -> None:
    build = compose["services"]["app"]["build"]
    assert build == {"context": "."}


def test_app_runs_on_loopback_port_8000(compose: dict) -> None:
    ports = compose["services"]["app"]["ports"]
    # The host port is left for Compose to assign randomly; the container
    # port is 8000 and access is bound to the loopback interface only.
    assert ports == ["127.0.0.1::8000"]


def test_app_exposes_healthcheck_probing_live_endpoint(compose: dict) -> None:
    healthcheck = compose["services"]["app"]["healthcheck"]
    test = healthcheck["test"]
    assert test[0] == "CMD"
    assert "/health" in test[-1]
    assert healthcheck["interval"]
    assert healthcheck["timeout"]
    assert healthcheck["start_period"]


def test_token_encryption_key_is_required_and_secrets_outside_image(compose: dict) -> None:
    app = compose["services"]["app"]
    environment = app.get("environment", {})
    # The key is interpolated from the host, never a checked-in plaintext value.
    assert environment["TOKEN_ENCRYPTION_KEY"] == "${TOKEN_ENCRYPTION_KEY:?TOKEN_ENCRYPTION_KEY is required}"
    # The key value is not hardcoded in the repository.
    assert "gAAAAA" not in yaml.safe_dump(environment)


def test_app_has_restart_policy(compose: dict) -> None:
    assert compose["services"]["app"]["restart"] == "unless-stopped"


def test_persistent_volume_is_named_and_mounted(compose: dict) -> None:
    app = compose["services"]["app"]
    volumes = app["volumes"]
    assert volumes == ["social-mcp-data:/data"]
    assert "social-mcp-data" in compose["volumes"]


def test_dockerfile_uses_non_root_user() -> None:
    text = dockerfile_text()
    assert "USER social-mcp" in text
    assert "social-mcp" in text


def test_dockerfile_creates_writable_data_directory() -> None:
    text = dockerfile_text()
    assert "mkdir -p /data" in text
    assert "chown social-mcp:social-mcp /data" in text


def test_dockerfile_exposes_port_8000() -> None:
    text = dockerfile_text()
    assert "EXPOSE 8000" in text


def test_dockerfile_runs_uvicorn_on_port_8000() -> None:
    text = dockerfile_text()
    assert "8000" in text
    assert "uvicorn" in text


def test_dockerignore_excludes_secrets_and_runtime_artifacts() -> None:
    dockerignore = (ROOT / ".dockerignore").read_text()
    for entry in [".env", "secrets/", "*.db", "build/", "dist/", ".venv/", "__pycache__/"]:
        assert entry in dockerignore


def test_gitignore_excludes_secrets_directory() -> None:
    gitignore = GITIGNORE.read_text()
    assert "secrets/" in gitignore
    for entry in [".env", "*.db", ".venv/", "__pycache__/"]:
        assert entry in gitignore


def test_env_example_does_not_contain_a_real_encryption_key() -> None:
    text = ENV_EXAMPLE.read_text()
    # The example must point deployments at the file-based secret, not set the
    # key inline. Any uncommented TOKEN_ENCRYPTION_KEY= must be empty.
    assert "TOKEN_ENCRYPTION_KEY_FILE" in text
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("#"):
            continue
        if "TOKEN_ENCRYPTION_KEY=" in stripped:
            assert stripped.split("=", 1)[1] == ""
    # No uncommented line carries a real Fernet key (base64 block ending in =).
    assert "gAAAAA" not in text


def test_env_example_mentions_secrets_directory() -> None:
    text = ENV_EXAMPLE.read_text()
    assert "secrets/" in text
    assert "token_encryption_key" in text


def test_deployment_document_exists_and_describes_persistence() -> None:
    assert DEPLOY_DOC.exists()
    text = DEPLOY_DOC.read_text()
    assert "persistent" in text.lower()
    assert "social-mcp-data" in text
    assert "token_encryption_key" in text


def test_readme_links_deployment_guide() -> None:
    text = README.read_text()
    assert "docs/deploy.md" in text


def test_deployment_document_makes_no_plaintext_secret_claims() -> None:
    text = DEPLOY_DOC.read_text().lower()
    # The document must not claim tokens are stored in plaintext.
    assert "plaintext token" not in text
