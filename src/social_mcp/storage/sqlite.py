import json
import sqlite3
from datetime import datetime
from pathlib import Path

from social_mcp.storage.models import ConnectedAccount, SocialPlatform


class SQLiteAccountStore:
    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)

    def initialize(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
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

    def save(self, account: ConnectedAccount) -> ConnectedAccount:
        with self._connect() as connection:
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
        with self._connect() as connection:
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
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT *
                FROM connected_accounts
                ORDER BY platform, username, external_account_id
                """
            ).fetchall()

        return [self._to_model(row) for row in rows]

    def _connect(self) -> sqlite3.Connection:
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
