"""SQLite storage for the connected-account table.

Every public method owns one short-lived connection through
:meth:`SQLiteAccountStore._connection`: successful writes are committed, failed
writes are rolled back, and the connection is closed whether the operation
succeeded or not. The ``with sqlite3.connect(...)`` form alone would only
commit or roll back and leave the open file handle to the garbage collector.
"""

import json
import sqlite3
from collections.abc import Iterator
from contextlib import closing, contextmanager
from datetime import datetime
from pathlib import Path

from social_mcp.storage.models import ConnectedAccount, SocialPlatform


class SQLiteAccountStore:
    """Connected-account store backed by a single SQLite database file."""

    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)

    def initialize(self) -> None:
        """Create the database file and account table, if either is missing."""

        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS connected_accounts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    platform TEXT NOT NULL,
                    external_account_id TEXT NOT NULL,
                    username TEXT,
                    scopes TEXT NOT NULL,
                    access_token_encrypted BLOB NOT NULL,
                    refresh_token_encrypted BLOB,
                    token_expires_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(platform, external_account_id)
                )
                """
            )

    def check(self) -> None:
        """Read the existing account table without creating a new database.

        Raises:
            sqlite3.Error: when the database cannot be opened or queried.
        """

        uri = f"{self.database_path.resolve().as_uri()}?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as connection:
            connection.execute("SELECT 1 FROM connected_accounts LIMIT 1").fetchone()

    def save(self, account: ConnectedAccount) -> ConnectedAccount:
        """Insert or update an account and return the stored row.

        Raises:
            sqlite3.Error: when the account cannot be written. The failed
                transaction is rolled back before the error reaches the caller.
            RuntimeError: when the account cannot be read back after the write.
        """

        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO connected_accounts (
                    platform,
                    external_account_id,
                    username,
                    scopes,
                    access_token_encrypted,
                    refresh_token_encrypted,
                    token_expires_at,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(platform, external_account_id) DO UPDATE SET
                    username = excluded.username,
                    scopes = excluded.scopes,
                    access_token_encrypted = excluded.access_token_encrypted,
                    refresh_token_encrypted = excluded.refresh_token_encrypted,
                    token_expires_at = excluded.token_expires_at,
                    updated_at = excluded.updated_at
                """,
                (
                    account.platform.value,
                    account.external_account_id,
                    account.username,
                    json.dumps(account.scopes),
                    account.access_token_encrypted,
                    account.refresh_token_encrypted,
                    self._serialize_datetime(account.token_expires_at),
                    account.created_at.isoformat(),
                    account.updated_at.isoformat(),
                ),
            )

        stored = self.get(account.platform, account.external_account_id)
        if stored is None:
            raise RuntimeError("Failed to read connected account after saving it.")
        return stored

    def get(
        self,
        platform: SocialPlatform,
        external_account_id: str,
    ) -> ConnectedAccount | None:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT *
                FROM connected_accounts
                WHERE platform = ? AND external_account_id = ?
                """,
                (platform.value, external_account_id),
            ).fetchone()

        return self._to_model(row) if row is not None else None

    def list_accounts(self) -> list[ConnectedAccount]:
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT *
                FROM connected_accounts
                ORDER BY platform, username, external_account_id
                """
            ).fetchall()

        return [self._to_model(row) for row in rows]

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        """Own one connection for a single store operation.

        Statements run on the yielded connection are committed when the body
        finishes and rolled back when it raises, so a failed write never leaves
        a partial transaction pending. The connection is then closed whichever
        way the operation ended, which the ``with sqlite3.connect(...)`` form
        never does: it only commits or rolls back and leaves the open file
        handle to the garbage collector.

        Raises:
            sqlite3.Error: when the database cannot be opened or written.
        """

        connection = self._connect()
        try:
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _connect(self) -> sqlite3.Connection:
        """Open one connection to the account database.

        The connection is handed over unowned so that :meth:`_connection`
        manages its whole lifecycle. Rows are read by column name and closing
        is an explicit act rather than the interpreter's.
        """

        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

    @staticmethod
    def _serialize_datetime(value: datetime | None) -> str | None:
        return value.isoformat() if value is not None else None

    @staticmethod
    def _to_model(row: sqlite3.Row) -> ConnectedAccount:
        return ConnectedAccount(
            id=row["id"],
            platform=SocialPlatform(row["platform"]),
            external_account_id=row["external_account_id"],
            username=row["username"],
            scopes=json.loads(row["scopes"]),
            access_token_encrypted=row["access_token_encrypted"],
            refresh_token_encrypted=row["refresh_token_encrypted"],
            token_expires_at=(
                datetime.fromisoformat(row["token_expires_at"])
                if row["token_expires_at"]
                else None
            ),
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )
