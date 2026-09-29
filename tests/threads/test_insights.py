"""Deterministic mocked tests for ``threads_get_insights``.

Tests cover:
  - account-level insights
  - post (content) insights
  - denied scopes/capabilities
  - invalid metric requests
"""

from __future__ import annotations

import pytest

from social_mcp.platforms.threads.insights import (
    InsightError,
    InsightErrorType,
    InsightScope,
    validate_requested_metrics,
)
from social_mcp.platforms.threads.insights_handler import (
    _normalize_account_insights,
    _normalize_post_insights,
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


class TestMetricValidation:
    def test_defaults_for_account_scope(self):
        result = validate_requested_metrics(None, InsightScope.ACCOUNT)
        assert "impressions" in result
        assert "followers_count" in result

    def test_defaults_for_post_scope(self):
        result = validate_requested_metrics(None, InsightScope.POST)
        assert "impressions" in result
        assert "likes" in result

    def test_dedup_preserving_order(self):
        result = validate_requested_metrics(
            ["likes", "impressions", "likes"], InsightScope.POST
        )
        assert len(result) == 2
        assert result[0] == "likes"

    def test_unknown_metric_rejected(self):
        with pytest.raises(InsightError) as exc_info:
            validate_requested_metrics(["nonexistent"], InsightScope.ACCOUNT)
        assert exc_info.value.error_type == InsightErrorType.INVALID_REQUEST

    def test_empty_list_rejected(self):
        with pytest.raises(InsightError) as exc_info:
            validate_requested_metrics([], InsightScope.ACCOUNT)
        assert exc_info.value.error_type == InsightErrorType.INVALID_REQUEST

    def test_account_only_metric_rejected_for_post(self):
        with pytest.raises(InsightError) as exc_info:
            validate_requested_metrics(["followers_count"], InsightScope.POST)
        assert exc_info.value.error_type == InsightErrorType.INVALID_REQUEST

    def test_post_only_metric_rejected_for_account(self):
        with pytest.raises(InsightError) as exc_info:
            validate_requested_metrics(["likes"], InsightScope.ACCOUNT)
        assert exc_info.value.error_type == InsightErrorType.INVALID_REQUEST


class TestNormalizers:
    def test_normalize_account_insights(self):
        raw = {
            "data": {"id": "acct_123"},
            "values": {"impressions": 42, "followers_count": 100},
            "timestamp": "2024-01-01T00:00:00Z",
        }
        result = _normalize_account_insights(raw, "acct_123", ["impressions", "followers_count"])
        assert result["scope"] == "account"
        assert result["platform"] == "threads"
        assert result["account_id"] == "acct_123"
        assert result["metrics"]["impressions"] == 42
        assert result["metrics"]["followers_count"] == 100

    def test_normalize_post_insights(self):
        raw = {"data": {"values": {"impressions": 10, "likes": 5, "replies": 2}}}
        result = _normalize_post_insights(raw, "post_1", ["impressions", "likes", "replies"])
        assert result["scope"] == "post"
        assert result["post_id"] == "post_1"
        assert result["metrics"]["impressions"] == 10
        assert result["metrics"]["likes"] == 5
        assert result["metrics"]["replies"] == 2


class TestHandleGetInsightsAccount:
    @pytest.mark.asyncio
    async def test_account_insights_success(self):
        account = FakeAccount()
        adapter = FakeAdapter(account_insights={
            "data": {"id": "acct_123"},
            "values": {"impressions": 42, "followers_count": 100},
            "timestamp": "2024-01-01T00:00:00Z",
        })
        result = await handle_get_insights(
            metrics=["impressions", "followers_count"],
            account=account,
            adapter=adapter,
        )
        assert result["scope"] == "account"
        assert result["account_id"] == "acct_123"
        assert result["metrics"]["impressions"] == 42
        assert result["metrics"]["followers_count"] == 100

    @pytest.mark.asyncio
    async def test_denied_capability(self):
        account = FakeAccount(has_capability=False)
        adapter = FakeAdapter()
        with pytest.raises(InsightError) as exc_info:
            await handle_get_insights(account=account, adapter=adapter)
        assert exc_info.value.error_type == InsightErrorType.PERMISSION_REQUIRED

    @pytest.mark.asyncio
    async def test_no_account(self):
        adapter = FakeAdapter()
        with pytest.raises(InsightError) as exc_info:
            await handle_get_insights(account=None, adapter=adapter)
        assert exc_info.value.error_type == InsightErrorType.AUTHENTICATION_REQUIRED
