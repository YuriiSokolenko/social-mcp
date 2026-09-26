from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr, model_validator
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

    # Threads OAuth redirect URI and scopes (issue #16). The redirect URI must
    # exactly match one of the app's registered valid OAuth URIs; when unset it
    # defaults to the development callback route. ``threads_scopes`` defaults to
    # ``threads_basic`` (the required minimum); ``parse_scopes`` always ensures
    # ``threads_basic`` is present. These are read from environment configuration
    # and never sent to the browser or baked into the image.
    threads_redirect_uri: str | None = None
    threads_scopes: str | None = None

    # Secret used to sign OAuth ``state`` values issued during the Threads
    # authorization-code flow (issue #15). It must be supplied at runtime from
    # the environment (or a secret file) and is never committed. A file-based
    # form is supported via ``OAUTH_STATE_SECRET_FILE``. It is independent of
    # ``ADMIN_SESSION_SECRET`` (which signs session cookies) and of
    # ``TOKEN_ENCRYPTION_KEY`` (which encrypts stored tokens); each secret has
    # a distinct purpose and must stay outside the database and Git.
    oauth_state_secret: str | None = None
    oauth_state_secret_file: Path | None = None

    admin_username: str | None = None
    admin_password: SecretStr | None = None

    # Secret used to sign Web Admin session cookies. It must be supplied at
    # runtime from the environment (or a secret file) and is never committed.
    # When omitted, the admin UI refuses logins and every /admin request is
    # rejected, so a deployment cannot accidentally expose an unprotected admin.
    # A file-based form is supported via ADMIN_SESSION_SECRET_FILE.
    admin_session_secret: SecretStr | None = None
    admin_session_secret_file: Path | None = None

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
        if (
            self.admin_session_secret is None
            and self.admin_session_secret_file is not None
        ):
            # A missing or unreadable session-secret file fails closed:
            # treat it as unset so the admin surface stays protected (503)
            # rather than crashing startup. The token-encryption key above
            # remains a hard failure because it is required at startup.
            try:
                value = self.admin_session_secret_file.read_text(
                    encoding="utf-8"
                ).strip()
            except OSError:
                value = ""
            if value:
                self.admin_session_secret = SecretStr(value)
        if (
            self.oauth_state_secret is None
            and self.oauth_state_secret_file is not None
        ):
            # A missing or unreadable OAuth-state-secret file fails closed:
            # treat it as unset so OAuth state minting/acceptance stays disabled
            # rather than crashing startup. The OAuth callback layer fails
            # closed when the secret is unavailable, mirroring the admin
            # session behaviour above.
            try:
                value = self.oauth_state_secret_file.read_text(
                    encoding="utf-8"
                ).strip()
            except OSError:
                value = ""
            if value:
                self.oauth_state_secret = value
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
