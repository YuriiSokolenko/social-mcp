"""Tests for the application container wired at startup.

All token material is fake: throwaway Fernet keys and in-memory placeholder
values. Nothing here touches real credentials or platform APIs.
"""

import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from social_mcp.config import Settings
from social_mcp.container import (
    ApplicationContainer,
    DatabaseUnavailableError,
    TokenCipherUnavailableError,
    build_container,
    create_container,
)
from social_mcp.storage.models import ConnectedAccount, SocialPlatform
from social_mcp.storage.sqlite import SQLiteAccountStore

VALID_KEY = Fernet.generate_key().decode("utf-8")


def test_build_container_exposes_settings_and_account_store(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    settings = make_settings(tmp_path)

    container = build_container(settings)

    assert isinstance(container, ApplicationContainer)
    assert container.settings is settings
    assert isinstance(container.account_store, SQLiteAccountStore)
    assert container.account_store.database_path == tmp_path / "data" / "social-mcp.db"


def test_build_container_has_no_side_effects(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    build_container(make_settings(tmp_path))

    assert not (tmp_path / "data" / "social-mcp.db").exists()
    assert not (tmp_path / "data").exists()


def test_start_creates_the_configured_database(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    container = create_container(make_settings(tmp_path))

    container.start()

    assert container.account_store.database_path.exists()
    assert container.account_store.list_accounts() == []
    container.check()


def test_start_is_idempotent_and_keeps_stored_accounts(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    container = create_container(make_settings(tmp_path))

    container.start()
    container.account_store.save(_account())
    container.start()

    assert len(container.account_store.list_accounts()) == 1


def test_start_reports_an_unusable_database_location(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    blocker = tmp_path / "blocked"
    blocker.write_text("not a directory")

    container = build_container(
        make_settings(tmp_path, database_url=f"sqlite:///{blocker / 'accounts.db'}")
    )

    with pytest.raises(DatabaseUnavailableError) as excinfo:
        container.start()

    assert "accounts.db" in str(excinfo.value)


def test_start_failure_never_mentions_the_encryption_key(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    blocker = tmp_path / "blocked"
    blocker.write_text("not a directory")
    container = build_container(
        make_settings(
            tmp_path,
            database_url=f"sqlite:///{blocker / 'accounts.db'}",
            token_encryption_key=VALID_KEY,
        )
    )

    with pytest.raises(DatabaseUnavailableError) as excinfo:
        container.start()

    assert VALID_KEY not in str(excinfo.value)


def test_check_reports_an_unreachable_database(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    container = create_container(make_settings(tmp_path))
    container.start()
    container.account_store.database_path = tmp_path / "removed" / "accounts.db"

    with pytest.raises(sqlite3.Error):
        container.check()


def test_encrypted_token_operations_require_a_configured_key(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    container = create_container(make_settings(tmp_path, token_encryption_key=None))

    assert container.token_cipher_or_none() is None
    with pytest.raises(TokenCipherUnavailableError, match="TOKEN_ENCRYPTION_KEY"):
        container.require_token_cipher()


@pytest.mark.parametrize("key", ["", "not-a-fernet-key", "x" * 32])
def test_a_malformed_key_is_treated_as_unusable(
    tmp_path: Path, make_settings: Callable[..., Settings], key: str
) -> None:
    container = create_container(make_settings(tmp_path, token_encryption_key=key))

    assert container.token_cipher_or_none() is None
    with pytest.raises(TokenCipherUnavailableError):
        container.require_token_cipher()


def test_valid_key_produces_a_working_cipher(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    container = create_container(make_settings(tmp_path, token_encryption_key=VALID_KEY))

    cipher = container.require_token_cipher()

    encrypted = cipher.encrypt("fake-token-value")
    assert encrypted != b"fake-token-value"
    assert cipher.decrypt(encrypted) == "fake-token-value"


def test_missing_key_warns_without_preventing_startup(
    tmp_path: Path,
    make_settings: Callable[..., Settings],
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level("WARNING"):
        container = create_container(make_settings(tmp_path, token_encryption_key=None))

    container.start()

    assert "TOKEN_ENCRYPTION_KEY" in caplog.text
    assert container.account_store.list_accounts() == []


def test_container_cipher_and_store_round_trip_an_encrypted_token(
    tmp_path: Path, make_settings: Callable[..., Settings]
) -> None:
    """The cipher the container hands out protects what the store persists."""

    container = create_container(make_settings(tmp_path))
    container.start()

    cipher = container.require_token_cipher()
    account = _account(cipher.encrypt("fake-access-token"))

    container.account_store.save(account)

    stored = container.account_store.get(SocialPlatform.THREADS, "10001")
    assert stored is not None
    assert stored.access_token_encrypted != b"fake-access-token"
    assert cipher.decrypt(stored.access_token_encrypted) == "fake-access-token"


def _account(access_token_encrypted: bytes = b"fake-encrypted-token") -> ConnectedAccount:
    now = datetime(2030, 1, 1, tzinfo=UTC)
    return ConnectedAccount(
        platform=SocialPlatform.THREADS,
        external_account_id="10001",
        username="tester",
        access_token_encrypted=access_token_encrypted,
        created_at=now,
        updated_at=now,
    )
