"""Shared helpers for the test suite.

Everything here uses throwaway values: temporary databases and in-process
Fernet keys. No real credentials or platform APIs are involved.
"""

from collections.abc import Callable
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from social_mcp.config import Settings

VALID_TOKEN_ENCRYPTION_KEY = Fernet.generate_key().decode("utf-8")


@pytest.fixture()
def make_settings() -> Callable[..., Settings]:
    """Return a settings factory bound to a caller-supplied tmp directory."""

    def build(tmp_path: Path, **overrides) -> Settings:
        values: dict[str, object] = {
            "database_url": f"sqlite:///{tmp_path / 'data' / 'social-mcp.db'}",
            "token_encryption_key": VALID_TOKEN_ENCRYPTION_KEY,
            **overrides,
        }
        return Settings(_env_file=None, **values)

    return build
