from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

SQLITE_URL_PREFIXES = ("sqlite:///", "sqlite:")


class ConfigurationError(ValueError):
    """Raised when a setting cannot produce a usable dependency.

    Derived from :class:`ValueError` so that a bad setting keeps failing as the
    value error it always was, while giving startup one type to catch.
    """


class Settings(BaseSettings):
    app_name: str = "Social MCP"
    environment: str = "development"

    database_url: str = "sqlite:///./data/social-mcp.db"

    meta_app_id: str | None = None
    meta_app_secret: str | None = None
    tiktok_client_key: str | None = None
    tiktok_client_secret: str | None = None

    token_encryption_key: str | None = None

    @property
    def database_path(self) -> Path:
        """The SQLite file behind ``DATABASE_URL``.

        The URL stays the deployment-facing setting while the account store
        works with a file path, so the translation lives here rather than in
        the storage or transport layers. A fourth slash denotes an absolute
        path (``sqlite:////data/db``), which is how the container mounts its
        volume, and a bare path is accepted as-is.

        Raises:
            ConfigurationError: when the URL points at something other than a
                local SQLite file. The check lives here so that neither the
                storage nor the transport layer has to interpret configuration.
        """

        url = self.database_url.strip()
        for prefix in SQLITE_URL_PREFIXES:
            if url.startswith(prefix):
                path = url.removeprefix(prefix)
                break
        else:
            if "://" in url:
                raise ConfigurationError("DATABASE_URL must be a local sqlite URL.")
            path = url

        if not path:
            raise ConfigurationError("DATABASE_URL must point to a SQLite file.")

        return Path(path)

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
