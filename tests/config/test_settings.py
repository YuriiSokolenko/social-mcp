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


def test_settings_read_environment_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "sqlite:////tmp/social-mcp.db")
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", "key-from-environment")

    settings = Settings(_env_file=None)

    assert str(settings.database_path) == "/tmp/social-mcp.db"
    assert settings.token_encryption_key == "key-from-environment"


def test_token_encryption_key_resolved_from_secret_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    key_file = tmp_path / "token_encryption_key"
    key_file.write_text("file-key-value  \n", encoding="utf-8")

    monkeypatch.delenv("TOKEN_ENCRYPTION_KEY", raising=False)
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY_FILE", str(key_file))

    settings = Settings(_env_file=None)

    assert settings.token_encryption_key == "file-key-value"


def test_explicit_key_takes_precedence_over_secret_file(tmp_path: Path) -> None:
    key_file = tmp_path / "token_encryption_key"
    key_file.write_text("file-key-value", encoding="utf-8")

    settings = Settings(
        _env_file=None,
        token_encryption_key="explicit-key",
        token_encryption_key_file=key_file,
    )

    assert settings.token_encryption_key == "explicit-key"


def test_no_key_or_file_leaves_key_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TOKEN_ENCRYPTION_KEY", raising=False)
    monkeypatch.delenv("TOKEN_ENCRYPTION_KEY_FILE", raising=False)

    settings = Settings(_env_file=None)

    assert settings.token_encryption_key is None


def test_secret_file_missing_raises(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    missing = tmp_path / "missing"
    monkeypatch.delenv("TOKEN_ENCRYPTION_KEY", raising=False)
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY_FILE", str(missing))

    with pytest.raises((FileNotFoundError, OSError)):
        Settings(_env_file=None)
