from functools import lru_cache
from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

SQLITE_URL_PREFIXES = ("sqlite:///", "sqlite:")


class Settings(BaseSettings):
    app_name: str = "Social MCP"
    environment: str = "development"

    database_url: str = "sqlite:///./data/social-mcp.db"

    meta_app_id: str | None = None
    meta_app_secret: str | None = None
    tiktok_client_key: str | None = None
    tiktok_client_secret: str | None = None

    # The key is supplied at runtime from the host environment. An alternative
    # ``TOKEN_ENCRYPTION_KEY_FILE`` form reads the key from a file (for example
    # a mounted Compose secret), which keeps it out of environment variables
    # and image layers. Either way the value lives only in memory and is never
    # written to the database or committed. An explicit
    # ``TOKEN_ENCRYPTION_KEY`` always wins.
    token_encryption_key: str | None = None
    token_encryption_key_file: Path | None = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @model_validator(mode="after")
    def _resolve_encryption_key_from_file(self) -> "Settings":
        """Resolve ``TOKEN_ENCRYPTION_KEY`` from a secret file when set.

        An explicit ``TOKEN_ENCRYPTION_KEY`` takes precedence; otherwise the
        file pointed to by ``TOKEN_ENCRYPTION_KEY_FILE`` is read into the
        field. The resolved value lives only in the in-memory instance, never
        in the file or in logs.
        """

        if self.token_encryption_key is None and self.token_encryption_key_file is not None:
            self.token_encryption_key = self.token_encryption_key_file.read_text(
                encoding="utf-8"
            ).strip()
        return self

    @property
    def database_path(self) -> Path:
        """The SQLite file behind ``DATABASE_URL``.

        The URL stays the deployment-facing setting while the account store
        works with a file path, so the translation lives here rather than in
        the storage or transport layers. A fourth slash denotes an absolute
        path (``sqlite:////data/db``), which is how the container mounts its
        volume, and a bare path is accepted as-is.
        """

        url = self.database_url.strip()
        for prefix in SQLITE_URL_PREFIXES:
            if url.startswith(prefix):
                path = url.removeprefix(prefix)
                break
        else:
            if "://" in url:
                raise ValueError("DATABASE_URL must be a local sqlite URL.")
            path = url

        if not path:
            raise ValueError("DATABASE_URL must point to a SQLite file.")

        return Path(path)


@lru_cache
def get_settings() -> Settings:
    return Settings()
