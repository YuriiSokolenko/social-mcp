"""Shared test fakes for Threads insights tests."""

from __future__ import annotations


class FakeAccount:
    def __init__(self, platform_user_id: str = "acct_123", has_capability: bool = True):
        self.platform_user_id = platform_user_id
        self._has_capability = has_capability


class FakeAdapter:
    def __init__(self, account_insights=None, post_insights=None,
                 raise_on_fetch=None, raise_on_decrypt=None):
        self._account_insights = account_insights
        self._post_insights = post_insights
        self._raise_on_fetch = raise_on_fetch
        self._raise_on_decrypt = raise_on_decrypt

    def has_insights_capability(self, account: FakeAccount) -> bool:
        return account._has_capability

    async def decrypt_account_token(self, account: FakeAccount) -> str:
        if self._raise_on_decrypt is not None:
            raise self._raise_on_decrypt
        return "decrypted_token"

    async def fetch_account_insights(self, token: str, metrics: list[str]) -> dict:
        if self._raise_on_fetch is not None:
            raise self._raise_on_fetch
        return self._account_insights or {
            "data": {"id": "acct_123"},
            "values": {m: 100 for m in metrics},
            "timestamp": "2024-01-01T00:00:00Z",
        }

    async def fetch_post_insights(self, token: str, post_id: str, metrics: list[str]) -> dict:
        if self._raise_on_fetch is not None:
            raise self._raise_on_fetch
        return self._post_insights or {
            "data": {"values": {m: 50 for m in metrics}},
        }
