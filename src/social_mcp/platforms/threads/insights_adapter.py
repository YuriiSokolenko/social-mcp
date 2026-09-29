"""Adapter interface for Threads insights.

Defines the minimal adapter protocol that ``threads_get_insights`` expects
from the existing Threads adapter. The real adapter (from #3) implements
these methods. This module also provides a helper to resolve the connected
account and decrypt its token via the existing boundary.
"""

from __future__ import annotations

import logging
from typing import Any, Protocol, runtime_checkable

logger = logging.getLogger(__name__)


@runtime_checkable
class InsightsAdapter(Protocol):
    """Minimal adapter interface required by the insights handler."""

    def has_insights_capability(self, account: Any) -> bool:
        ...

    async def decrypt_account_token(self, account: Any) -> str:
        ...

    async def fetch_account_insights(self, token: str, metrics: list[str]) -> dict[str, Any]:
        ...

    async def fetch_post_insights(
        self, token: str, post_id: str, metrics: list[str]
    ) -> dict[str, Any]:
        ...


def get_insights_adapter(platform: Any | None = None) -> InsightsAdapter | None:
    """Return the connected Threads insights adapter, if available.

    Reuses the existing platform/adapter infrastructure. Returns ``None``
    if no Threads adapter is connected.
    """
    if platform is None:
        return None

    # The platform object from #3 should expose a Threads adapter.
    adapter = getattr(platform, "threads_adapter", None)
    if adapter is None and hasattr(platform, "get"):
        adapter = platform.get("threads_adapter")
    return adapter
