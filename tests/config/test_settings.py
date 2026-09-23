"""Tests for configuration and its SQLite path resolution."""

from pathlib import Path

import pytest

from social_mcp.config import Settings


def resolved_path(database_url: str) -> Path:
    """Resolve a DATABASE_URL through a Settings instance."""

    return Settings.model_construct(database_url=database_url).database_path


@pytest.mark.parametrize(
    ("database_url", "expected"),
    [
        ("sqlite:///./data/social-mcp.db", "data/social-mcp.db"),
        ("sqlite:////data/social-mcp.db", "/data/social-mcp.db"),
        ("sqlite:///var/social-mcp.db", "var/social-mcp.db"),
        ("data/relative/social-mcp.db", "data/relative/social-mcp.db"),
    ],
)
def test_database_path_resolves_the_configured_url(database_url: str, expected: str) -> None:
    assert str(resolved_path(database_url)) == expected


def test_default_settings_point_at_the_default_database_file() -> None:
    settings = Settings.model_construct()

    assert str(settings.database_path) == "data/social-mcp.db"


@pytest.mark.parametrize(
    "database_url",
    ["postgres:///social-mcp.db", "mysql://localhost/social", "sqlite:///"],
)
def test_database_path_rejects_non_sqlite_or_empty_urls(database_url: str) -> None:
    with pytest.raises(ValueError, match="DATABASE_URL"):
        resolved_path(database_url)


def test_settings_read_environment_values(monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "sqlite:////tmp/social-mcp.db")
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", "key-from-environment")

    settings = Settings(_env_file=None)

    assert str(settings.database_path) == "/tmp/social-mcp.db"
    assert settings.token_encryption_key == "key-from-environment"
