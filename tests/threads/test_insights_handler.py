"""Handler and provider-error tests for threads_get_insights."""

from __future__ import annotations

import pytest

from social_mcp.platforms.threads.insights import (
    InsightError,
    InsightErrorType,
)
from social_mcp.platforms.threads.insights_handler import (
    _classify_provider_error,
    handle_get_insights,
)


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


class RateLimitError(Exception):
    pass


class NotFoundError(Exception):
    pass


class BadRequestError(Exception):
    pass


class TestHandleGetInsightsPost:
    @pytest.mark.asyncio
    async def test_post_insights_success(self):
        account = FakeAccount()
        adapter = FakeAdapter(post_insights={
            "data": {"values": {"impressions": 10, "likes": 5}},
        })
        result = await handle_get_insights(
            post_id="post_1",
            metrics=["impressions", "likes"],
            account=account,
            adapter=adapter,
        )
        assert result["scope"] == "post"
        assert result["post_id"] == "post_1"
        assert result["metrics"]["impressions"] == 10
        assert result["metrics"]["likes"] == 5

    @pytest.mark.asyncio
    async def test_post_insights_default_metrics(self):
        account = FakeAccount()
        adapter = FakeAdapter(post_insights={
            "data": {"values": {"impressions": 3, "likes": 1, "shares": 0}},
        })
        result = await handle_get_insights(
            post_id="post_1",
            account=account,
            adapter=adapter,
        )
        assert result["scope"] == "post"
        assert "impressions" in result["metrics"]


class TestInvalidRequest:
    @pytest.mark.asyncio
    async def test_unknown_metric_rejected(self):
        account = FakeAccount()
        adapter = FakeAdapter()
        with pytest.raises(InsightError) as exc_info:
            await handle_get_insights(
                metrics=["bogus_metric"],
                account=account,
                adapter=adapter,
            )
        assert exc_info.value.error_type == InsightErrorType.INVALID_REQUEST

    @pytest.mark.asyncio
    async def test_post_only_metric_for_account_scope(self):
        account = FakeAccount()
        adapter = FakeAdapter()
        with pytest.raises(InsightError) as exc_info:
            await handle_get_insights(
                metrics=["likes"],
                account=account,
                adapter=adapter,
            )
        assert exc_info.value.error_type == InsightErrorType.INVALID_REQUEST


class TestProviderErrors:
    @pytest.mark.asyncio
    async def test_rate_limit_mapped(self):
        account = FakeAccount()
        adapter = FakeAdapter(raise_on_fetch=RateLimitError("rate limit exceeded"))
        with pytest.raises(InsightError) as exc_info:
            await handle_get_insights(account=account, adapter=adapter)
        assert exc_info.value.error_type == InsightErrorType.RATE_LIMITED
        assert exc_info.value.retryable is True

    @pytest.mark.asyncio
    async def test_transient_connection_error(self):
        account = FakeAccount()
        adapter = FakeAdapter(raise_on_fetch=ConnectionError("connection refused"))
        with pytest.raises(InsightError) as exc_info:
            await handle_get_insights(account=account, adapter=adapter)
        assert exc_info.value.error_type == InsightErrorType.TEMPORARY_FAILURE
        assert exc_info.value.retryable is True

    @pytest.mark.asyncio
    async def test_platform_error(self):
        account = FakeAccount()
        adapter = FakeAdapter(raise_on_fetch=ValueError("unexpected internal state"))
        with pytest.raises(InsightError) as exc_info:
            await handle_get_insights(account=account, adapter=adapter)
        assert exc_info.value.error_type == InsightErrorType.PLATFORM_ERROR

    @pytest.mark.asyncio
    async def test_not_found(self):
        account = FakeAccount()
        adapter = FakeAdapter(raise_on_fetch=NotFoundError("404 not found"))
        with pytest.raises(InsightError) as exc_info:
            await handle_get_insights(
                post_id="missing_post",
                account=account,
                adapter=adapter,
            )
        assert exc_info.value.error_type == InsightErrorType.NOT_FOUND

    @pytest.mark.asyncio
    async def test_bad_request(self):
        account = FakeAccount()
        adapter = FakeAdapter(raise_on_fetch=BadRequestError("invalid parameter"))
        with pytest.raises(InsightError) as exc_info:
            await handle_get_insights(account=account, adapter=adapter)
        assert exc_info.value.error_type == InsightErrorType.INVALID_REQUEST

    @pytest.mark.asyncio
    async def test_permission_error(self):
        account = FakeAccount()
        adapter = FakeAdapter(raise_on_fetch=PermissionError("insufficient scope"))
        with pytest.raises(InsightError) as exc_info:
            await handle_get_insights(account=account, adapter=adapter)
        assert exc_info.value.error_type == InsightErrorType.PERMISSION_REQUIRED


class TestProviderErrorClassification:
    def test_rate_limit_directly(self):
        err = _classify_provider_error(RateLimitError("rate limit exceeded"))
        assert err.error_type == InsightErrorType.RATE_LIMITED
        assert err.retryable is True

    def test_transient_directly(self):
        err = _classify_provider_error(ConnectionError("timeout reading stream"))
        assert err.error_type == InsightErrorType.TEMPORARY_FAILURE
        assert err.retryable is True

    def test_platform_error_directly(self):
        err = _classify_provider_error(RuntimeError("unexpected state"))
        assert err.error_type == InsightErrorType.PLATFORM_ERROR

    def test_no_credentials_leaked(self):
        """Errors must never contain token/secret values."""
        err = _classify_provider_error(PermissionError("token abc123 has no scope"))
        assert "abc123" not in err.message
        assert "abc123" not in str(err.metadata)
