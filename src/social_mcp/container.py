"""Wires configuration, storage and token cryptography into one container.

The transport layers, platform adapters and Web Admin receive ready
dependencies from here instead of constructing infrastructure themselves.
Application startup creates the SQLite account store; the token cipher is
handed only to code that performs encrypted token operations, and only when
TOKEN_ENCRYPTION_KEY is usable.
"""

import logging
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from social_mcp.auth.token_cipher import TokenCipher
from social_mcp.config import ConfigurationError, Settings
from social_mcp.storage.sqlite import SQLiteAccountStore

logger = logging.getLogger(__name__)


class StartupError(RuntimeError):
    """Raised when the configured dependencies cannot be created."""


class DatabaseUnavailableError(StartupError):
    """Raised when the configured SQLite database cannot be used."""

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        super().__init__(f"Unable to initialise the account database at {database_path}.")


class TokenCipherUnavailableError(StartupError):
    """Raised when an encrypted token operation has no usable key."""

    def __init__(self) -> None:
        super().__init__("TOKEN_ENCRYPTION_KEY must be configured for token operations.")


class ContainerUnavailableError(StartupError):
    """Raised when a request reaches the application before startup finished."""

    def __init__(self) -> None:
        super().__init__("The application container is unavailable; startup did not complete.")


@dataclass(frozen=True)
class ApplicationContainer:
    """The application dependencies, created once at startup."""

    settings: Settings
    account_store: SQLiteAccountStore

    def start(self) -> None:
        """Create the account database and confirm the store is reachable.

        Raises:
            DatabaseUnavailableError: when the configured location cannot be
                created or opened. The message holds the path only, never
                credentials or the encryption key.
        """

        try:
            self.account_store.initialize()
            self.account_store.check()
        except (sqlite3.Error, OSError) as exc:
            raise DatabaseUnavailableError(self.account_store.database_path) from exc

    def token_cipher_or_none(self) -> TokenCipher | None:
        """Return the token cipher built from this container's configuration.

        Construction lives in :func:`token_cipher_factory`, the application
        boundary, so the auth layer never parses configuration itself. A
        missing or malformed key behaves like an absent one and the
        configured value is never surfaced.
        """

        return token_cipher_factory(self.settings)

    def require_token_cipher(self) -> TokenCipher:
        """Return the cipher for an encrypted token operation.

        Only the auth/storage layers that encrypt, decrypt or persist tokens
        may call this, so a missing or malformed key fails loudly rather than
        degrading to plaintext token handling.
        """

        cipher = self.token_cipher_or_none()
        if cipher is None:
            raise TokenCipherUnavailableError()
        return cipher

    def check(self) -> None:
        """Confirm the storage dependency this container owns is usable.

        Raises:
            sqlite3.Error: when the account database cannot be read.
        """

        self.account_store.check()


def token_cipher_factory(settings: Settings) -> TokenCipher | None:
    """Build the token cipher from configuration without raising.

    The cipher is a boundary dependency: parsing the configured key happens
    here, once per call, rather than inside the auth layer, and a missing or
    malformed key is reported as ``None``. The configured value is never
    surfaced.
    """

    key = settings.token_encryption_key
    if not key:
        return None
    try:
        return TokenCipher(key)
    except ConfigurationError:
        # A malformed key is a configuration problem and behaves like an
        # absent one: encrypted token operations stay disabled and are
        # enforced per operation by require_token_cipher().
        return None


def build_container(
    settings: Settings,
    *,
    account_store: SQLiteAccountStore | None = None,
) -> ApplicationContainer:
    """Create the container from configuration without side effects.

    The store resolves from ``settings.database_path`` unless one is injected,
    so that storage can be supplied at the application boundary instead of
    being rebuilt per caller.

    Startup goes through :func:`create_container` and
    :meth:`ApplicationContainer.start`; this exists for tests and callers that
    handle configuration failures themselves.
    """

    return ApplicationContainer(
        settings=settings,
        account_store=account_store or SQLiteAccountStore(settings.database_path),
    )


def create_container(settings: Settings) -> ApplicationContainer:
    """Create the application dependencies from configuration.

    The account database itself is created at application startup by
    :meth:`ApplicationContainer.start`, so building a container stays free of
    filesystem side effects.

    A missing or malformed encryption key does not stop startup: it only
    disables encrypted token operations, which is enforced per operation by
    :meth:`ApplicationContainer.require_token_cipher`.
    """

    container = build_container(settings)
    if token_cipher_factory(settings) is None:
        logger.warning(
            "TOKEN_ENCRYPTION_KEY is missing or invalid; encrypted token operations are disabled."
        )
    return container
