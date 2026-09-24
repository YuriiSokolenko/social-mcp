"""Deterministic tests for the SQLite connected-account store.

All token material in these tests is fake: it is either opaque placeholder
bytes or values encrypted in-process with a throwaway Fernet key. Nothing here
touches real credentials or platform APIs.
"""

import sqlite3
from datetime import UTC, datetime

import pytest
from cryptography.fernet import Fernet

from social_mcp.auth.token_cipher import TokenCipher
from social_mcp.storage.models import ConnectedAccount, SocialPlatform
from social_mcp.storage.sqlite import SQLiteAccountStore

FAKE_ACCESS_TOKEN = "fake-access-token-not-a-real-credential"
FAKE_REFRESH_TOKEN = "fake-refresh-token-not-a-real-credential"

CREATED_AT = datetime(2030, 1, 1, 12, 0, 30, tzinfo=UTC)


@pytest.fixture()
def cipher() -> TokenCipher:
    return TokenCipher(Fernet.generate_key().decode("utf-8"))


@pytest.fixture()
def store(tmp_path) -> SQLiteAccountStore:
    """A store backed by a fresh, temporary database file."""
    account_store = SQLiteAccountStore(tmp_path / "data" / "social-mcp.db")
    account_store.initialize()
    return account_store


def build_account(
    *,
    platform: SocialPlatform = SocialPlatform.THREADS,
    external_account_id: str = "10001",
    username: str | None = "tester",
    scopes: list[str] | None = None,
    access_token_encrypted: bytes = b"fake-access-token-bytes",
    refresh_token_encrypted: bytes | None = None,
    token_expires_at: datetime | None = None,
    created_at: datetime = CREATED_AT,
    updated_at: datetime | None = None,
) -> ConnectedAccount:
    return ConnectedAccount(
        platform=platform,
        external_account_id=external_account_id,
        username=username,
        scopes=scopes if scopes is not None else ["threads_basic"],
        access_token_encrypted=access_token_encrypted,
        refresh_token_encrypted=refresh_token_encrypted,
        token_expires_at=token_expires_at,
        created_at=created_at,
        updated_at=updated_at if updated_at is not None else created_at,
    )


# The real connector, so the helpers below keep working while the connection
# audit fixture patches sqlite3.connect.
_CONNECT = sqlite3.connect

# Every store method the issue holds responsible for one connection.
_PUBLIC_OPS = {
    "initialize": lambda store: store.initialize(),
    "save": lambda store: store.save(build_account()),
    "get": lambda store: store.get(SocialPlatform.THREADS, "10001"),
    "list_accounts": lambda store: store.list_accounts(),
}

# One account row written straight to SQL, with fake encrypted token material.
INSERTED_ACCOUNT_ROW = """
    INSERT INTO connected_accounts (
        platform,
        external_account_id,
        username,
        scopes,
        access_token_encrypted,
        created_at,
        updated_at
    )
    VALUES ('threads', '10001', 'tester', '[]',
            X'66616B652D746F6B656E',
            '2030-01-01T12:00:30+00:00',
            '2030-01-01T12:00:30+00:00')
    """


def raw_rows(database_path) -> list[tuple]:
    with _CONNECT(database_path) as connection:
        return connection.execute(
            """
            SELECT platform, external_account_id, access_token_encrypted,
                   refresh_token_encrypted, created_at, updated_at
            FROM connected_accounts
            ORDER BY id
            """
        ).fetchall()


class ConnectionSpy(sqlite3.Connection):
    """Connection recording the lifecycle calls the store makes on it.

    ``events`` shows the order in which the connection was committed, rolled
    back, and closed, so a test can tell a commit apart from a rollback and
    both apart from a plain read. ``closed`` reports whether the file handle
    was released.
    """

    closed: bool = False

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.events: list[str] = []

    def commit(self) -> None:
        self.events.append("commit")
        super().commit()

    def rollback(self) -> None:
        self.events.append("rollback")
        super().rollback()

    def close(self) -> None:
        self.events.append("close")
        self.closed = True
        super().close()


class ConnectionAudit:
    """The connections a store opens, in order, for one test."""

    def __init__(self) -> None:
        self.connections: list[ConnectionSpy] = []

    def reset(self) -> None:
        """Forget the connections opened before the operation under test."""

        self.connections.clear()

    def assert_all_closed(self) -> None:
        """Fail when any recorded connection still holds its file handle."""

        still_open = [
            index for index, connection in enumerate(self.connections) if not connection.closed
        ]
        assert not still_open, f"connections left open: {still_open}"

    def assert_events(self, index: int, *expected: str) -> None:
        """Fail when the recorded connection at ``index`` did something else."""

        assert self.connections[index].events == list(expected)


@pytest.fixture()
def connection_audit(monkeypatch: pytest.MonkeyPatch) -> ConnectionAudit:
    """Record every connection the store opens, closed or not."""

    audit = ConnectionAudit()

    def recording_connect(database, *args, **kwargs):
        kwargs["factory"] = ConnectionSpy
        connection = _CONNECT(database, *args, **kwargs)
        audit.connections.append(connection)
        return connection

    monkeypatch.setattr(sqlite3, "connect", recording_connect)
    return audit


@pytest.fixture(params=list(_PUBLIC_OPS))
def connection_operation(request: pytest.FixtureRequest):
    """One store method that owns a connection, one test at a time."""

    return _PUBLIC_OPS[request.param]


@pytest.fixture()
def failing_account_writes(store: SQLiteAccountStore) -> None:
    """Fail every account write after the statement has run, deterministically."""

    with _CONNECT(store.database_path) as connection:
        connection.execute(
            """
            CREATE TRIGGER IF NOT EXISTS fails_account_writes
            BEFORE INSERT ON connected_accounts
            BEGIN
                SELECT RAISE(ABORT, 'simulated storage failure');
            END
            """
        )


def test_initialize_creates_the_database_and_is_idempotent(tmp_path) -> None:
    database_path = tmp_path / "nested" / "social-mcp.db"

    SQLiteAccountStore(database_path).initialize()
    SQLiteAccountStore(database_path).initialize()

    assert database_path.exists()
    assert SQLiteAccountStore(database_path).list_accounts() == []


def test_save_then_get_returns_the_account(store: SQLiteAccountStore) -> None:
    expires_at = datetime(2030, 6, 1, 8, 15, tzinfo=UTC)
    account = build_account(
        scopes=["threads_basic", "threads_content_publish"],
        token_expires_at=expires_at,
    )

    stored = store.save(account)
    fetched = store.get(SocialPlatform.THREADS, "10001")

    assert stored.id is not None
    assert stored == account.model_copy(update={"id": stored.id})
    assert fetched == stored
    assert fetched.platform is SocialPlatform.THREADS
    assert fetched.username == "tester"
    assert fetched.scopes == ["threads_basic", "threads_content_publish"]
    assert fetched.token_expires_at == expires_at


def test_get_returns_none_for_unknown_account(store: SQLiteAccountStore) -> None:
    store.save(build_account())

    assert store.get(SocialPlatform.THREADS, "does-not-exist") is None
    assert store.get(SocialPlatform.TIKTOK, "10001") is None


def test_encrypted_token_bytes_round_trip_unchanged(
    store: SQLiteAccountStore,
    cipher: TokenCipher,
) -> None:
    access_token_encrypted = cipher.encrypt(FAKE_ACCESS_TOKEN)
    refresh_token_encrypted = cipher.encrypt(FAKE_REFRESH_TOKEN)

    stored = store.save(
        build_account(
            access_token_encrypted=access_token_encrypted,
            refresh_token_encrypted=refresh_token_encrypted,
        )
    )

    fetched = store.get(SocialPlatform.THREADS, "10001")
    assert fetched is not None

    for persisted in (stored, fetched):
        assert isinstance(persisted.access_token_encrypted, bytes)
        assert isinstance(persisted.refresh_token_encrypted, bytes)
        assert persisted.access_token_encrypted == access_token_encrypted
        assert persisted.refresh_token_encrypted == refresh_token_encrypted
        assert cipher.decrypt(persisted.access_token_encrypted) == FAKE_ACCESS_TOKEN
        assert cipher.decrypt(persisted.refresh_token_encrypted) == FAKE_REFRESH_TOKEN

    stored_row = raw_rows(store.database_path)[0]
    assert stored_row[2] == access_token_encrypted
    assert stored_row[3] == refresh_token_encrypted


def test_refresh_token_is_stored_as_absent_when_not_provided(
    store: SQLiteAccountStore,
) -> None:
    store.save(build_account(refresh_token_encrypted=None))

    fetched = store.get(SocialPlatform.THREADS, "10001")
    assert fetched is not None
    assert fetched.refresh_token_encrypted is None
    assert raw_rows(store.database_path)[0][3] is None


def test_plaintext_token_is_never_written_to_the_database_file(
    store: SQLiteAccountStore,
    cipher: TokenCipher,
) -> None:
    store.save(
        build_account(
            access_token_encrypted=cipher.encrypt(FAKE_ACCESS_TOKEN),
            refresh_token_encrypted=cipher.encrypt(FAKE_REFRESH_TOKEN),
        )
    )

    raw_database = store.database_path.read_bytes()

    assert FAKE_ACCESS_TOKEN.encode("utf-8") not in raw_database
    assert FAKE_REFRESH_TOKEN.encode("utf-8") not in raw_database


def test_saving_same_platform_and_external_id_updates_without_duplicate(
    store: SQLiteAccountStore,
    cipher: TokenCipher,
) -> None:
    new_access_token = cipher.encrypt(FAKE_ACCESS_TOKEN)

    store.save(build_account(username="tester"))
    updated = store.save(
        build_account(
            username="renamed-tester",
            scopes=["threads_basic", "threads_content_publish"],
            access_token_encrypted=new_access_token,
        )
    )

    accounts = store.list_accounts()
    assert len(accounts) == 1
    assert accounts[0] == updated
    assert accounts[0].id is not None
    assert accounts[0].username == "renamed-tester"
    assert accounts[0].scopes == ["threads_basic", "threads_content_publish"]
    assert accounts[0].access_token_encrypted == new_access_token
    assert cipher.decrypt(accounts[0].access_token_encrypted) == FAKE_ACCESS_TOKEN
    assert len(raw_rows(store.database_path)) == 1


def test_update_keeps_created_at_and_writes_new_updated_at(
    store: SQLiteAccountStore,
) -> None:
    old_updated_at = CREATED_AT
    new_updated_at = datetime(2031, 3, 4, 9, 30, tzinfo=UTC)

    store.save(build_account(updated_at=old_updated_at))
    stored = store.save(build_account(updated_at=new_updated_at))

    assert stored.created_at == CREATED_AT
    assert stored.updated_at == new_updated_at
    stored_row = raw_rows(store.database_path)[0]
    assert stored_row[4] == CREATED_AT.isoformat()
    assert stored_row[5] == new_updated_at.isoformat()


def test_accounts_with_the_same_id_on_different_platforms_are_not_duplicates(
    store: SQLiteAccountStore,
) -> None:
    store.save(build_account(platform=SocialPlatform.THREADS, external_account_id="shared-id"))
    store.save(build_account(platform=SocialPlatform.TIKTOK, external_account_id="shared-id"))

    accounts = store.list_accounts()

    assert len(accounts) == 2
    assert {account.platform for account in accounts} == {
        SocialPlatform.THREADS,
        SocialPlatform.TIKTOK,
    }
    assert store.get(SocialPlatform.THREADS, "shared-id") is not None
    assert store.get(SocialPlatform.TIKTOK, "shared-id") is not None


def test_list_accounts_returns_every_stored_account(
    store: SQLiteAccountStore,
) -> None:
    assert store.list_accounts() == []

    store.save(build_account(platform=SocialPlatform.THREADS, external_account_id="1"))
    store.save(build_account(platform=SocialPlatform.THREADS, external_account_id="2"))
    store.save(build_account(platform=SocialPlatform.TIKTOK, external_account_id="3"))

    accounts = store.list_accounts()

    assert [(account.platform, account.external_account_id) for account in accounts] == [
        (SocialPlatform.THREADS, "1"),
        (SocialPlatform.THREADS, "2"),
        (SocialPlatform.TIKTOK, "3"),
    ]
    assert all(account.id is not None for account in accounts)


def test_list_accounts_orders_by_platform_then_username(
    store: SQLiteAccountStore,
) -> None:
    store.save(
        build_account(platform=SocialPlatform.TIKTOK, external_account_id="zoe", username="zoe")
    )
    store.save(
        build_account(platform=SocialPlatform.THREADS, external_account_id="bob", username="bob")
    )
    store.save(
        build_account(
            platform=SocialPlatform.THREADS, external_account_id="alice", username="alice"
        )
    )

    accounts = store.list_accounts()

    assert [(account.platform, account.username) for account in accounts] == [
        (SocialPlatform.THREADS, "alice"),
        (SocialPlatform.THREADS, "bob"),
        (SocialPlatform.TIKTOK, "zoe"),
    ]


def test_check_passes_for_an_initialized_store(store: SQLiteAccountStore) -> None:
    store.check()

    store.save(build_account())
    store.check()


def test_check_raises_when_the_database_is_unreachable(
    store: SQLiteAccountStore,
    tmp_path,
) -> None:
    store.database_path = tmp_path / "removed" / "social-mcp.db"

    with pytest.raises(sqlite3.Error):
        store.check()


def test_check_does_not_recreate_a_deleted_database(store: SQLiteAccountStore) -> None:
    store.database_path.unlink()

    with pytest.raises(sqlite3.OperationalError):
        store.check()

    assert not store.database_path.exists()


def test_check_rejects_corrupted_database_header(store: SQLiteAccountStore) -> None:
    with store.database_path.open("r+b") as database:
        database.write(b"not a sqlite db!")

    with pytest.raises(sqlite3.DatabaseError):
        store.check()


def test_check_rejects_database_without_account_table(store: SQLiteAccountStore) -> None:
    store.database_path.unlink()
    sqlite3.connect(store.database_path).close()

    with pytest.raises(sqlite3.OperationalError, match="no such table"):
        store.check()


def test_every_operation_closes_the_connection_it_opened(
    store: SQLiteAccountStore,
    connection_audit: ConnectionAudit,
    connection_operation,
) -> None:
    """No store method may hand an open file handle back to its caller."""

    connection_audit.reset()
    connection_operation(store)

    assert connection_audit.connections, "the store opened no connection at all"
    connection_audit.assert_all_closed()


def test_every_operation_closes_its_connection_when_the_database_is_unusable(
    store: SQLiteAccountStore,
    connection_audit: ConnectionAudit,
    connection_operation,
) -> None:
    """A failed operation closes the connection it opened just as firmly."""

    store.database_path.unlink()
    store.database_path.write_bytes(b"not a sqlite database file")
    connection_audit.reset()

    with pytest.raises(sqlite3.Error):
        connection_operation(store)

    assert connection_audit.connections, "the store opened no connection at all"
    connection_audit.assert_all_closed()


def test_successful_save_commits_then_closes(
    store: SQLiteAccountStore,
    connection_audit: ConnectionAudit,
) -> None:
    connection_audit.reset()

    store.save(build_account())

    # The read-back in save() opens a second connection.
    assert len(connection_audit.connections) == 2
    connection_audit.assert_events(0, "commit", "close")
    connection_audit.assert_all_closed()
    assert store.get(SocialPlatform.THREADS, "10001") is not None


def test_reads_close_their_connection(
    store: SQLiteAccountStore,
    connection_audit: ConnectionAudit,
) -> None:
    store.save(build_account())
    connection_audit.reset()

    store.get(SocialPlatform.THREADS, "10001")
    store.list_accounts()

    connection_audit.assert_events(0, "commit", "close")
    connection_audit.assert_events(1, "commit", "close")
    connection_audit.assert_all_closed()


def test_check_closes_its_read_only_connection(
    store: SQLiteAccountStore,
    connection_audit: ConnectionAudit,
) -> None:
    connection_audit.reset()

    store.check()

    connection_audit.assert_events(0, "close")
    connection_audit.assert_all_closed()


def test_failed_write_rolls_back_and_closes(
    store: SQLiteAccountStore,
    connection_audit: ConnectionAudit,
    failing_account_writes: None,
) -> None:
    connection_audit.reset()

    with pytest.raises(sqlite3.Error, match="simulated storage failure"):
        store.save(build_account())

    connection_audit.assert_events(0, "rollback", "close")
    connection_audit.assert_all_closed()
    assert store.list_accounts() == []


def test_connection_rolls_back_a_write_that_fails_mid_transaction(
    store: SQLiteAccountStore,
) -> None:
    """A statement that succeeded must not survive a later failure."""

    with (
        pytest.raises(RuntimeError, match="storage failed mid-write"),
        store._connection() as connection,
    ):
        connection.execute(INSERTED_ACCOUNT_ROW)
        raise RuntimeError("storage failed mid-write")

    assert store.list_accounts() == []


def test_connection_still_closes_when_the_rollback_itself_fails(
    store: SQLiteAccountStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Closing must not be skipped even when the rollback itself fails."""

    audit = ConnectionAudit()

    class Unrollbackable(ConnectionSpy):
        def rollback(self) -> None:
            self.events.append("rollback")
            raise sqlite3.OperationalError("rollback failed")

    def connect(database, *args, **kwargs):
        kwargs["factory"] = Unrollbackable
        connection = _CONNECT(database, *args, **kwargs)
        audit.connections.append(connection)
        return connection

    monkeypatch.setattr(sqlite3, "connect", connect)

    # The failed rollback surfaces instead of the original error, but the
    # connection is closed all the same.
    with (
        pytest.raises(sqlite3.OperationalError, match="rollback failed"),
        store._connection() as connection,
    ):
        connection.execute("SELECT 1")
        raise RuntimeError("storage failed mid-write")

    audit.assert_events(0, "rollback", "close")
