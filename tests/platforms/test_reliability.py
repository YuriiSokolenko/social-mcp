"""Deterministic tests for the shared platform HTTP reliability policy.

Every test uses an :class:`httpx.MockTransport` and a recording sleep so no
real network or wall-clock waits occur. The reliability policy under test is
:mod:`social_mcp.platforms.reliability`, which the Threads and TikTok adapters
share.
"""

from __future__ import annotations

import random
from collections.abc import Callable, Sequence
from datetime import UTC, datetime

import httpx
import pytest
from pydantic import ValidationError

from social_mcp.platforms.reliability import (
    RETRYABLE_STATUS_CODES,
    SAFE_METHODS,
    PlatformHttpClient,
    PlatformHttpConfig,
    PlatformHttpError,
    RateLimitError,
    TransientError,
    can_retry,
    compute_backoff_delay,
    is_rate_limited_status,
    is_transient_status,
    retry_after_delay,
)

# A conservative base config for tests: deterministic (jitter off) so backoff
# delays are exact and predictable.
BASE_CONFIG = PlatformHttpConfig(jitter=False)

# A fixed reference time used to make HTTP-date ``Retry-After`` deterministic.
FIXED_NOW = datetime(2026, 10, 21, 7, 28, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class ScriptedTransport:
    """A mock transport that returns scripted responses/exceptions in order.

    Each item is either an :class:`httpx.Response` (returned) or a
    :class:`BaseException` (raised as a transport error). Every request is
    recorded, including those whose handler raised.
    """

    def __init__(self, responses: Sequence[httpx.Response | BaseException]) -> None:
        self._pending: list[httpx.Response | BaseException] = list(responses)
        self.requests: list[httpx.Request] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        item = self._pending.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)


class RecordingSleep:
    """An async sleep that records every requested delay instead of waiting."""

    def __init__(self) -> None:
        self.calls: list[float] = []
        self.total: float = 0.0

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)
        self.total += seconds


def _client(
    responses: Sequence[httpx.Response | BaseException],
    *,
    config: PlatformHttpConfig | None = None,
    sleep: RecordingSleep | None = None,
    rng: random.Random | None = None,
    now: Callable[[], datetime] | None = None,
) -> tuple[PlatformHttpClient, ScriptedTransport, RecordingSleep]:
    """Build a client wired to a scripted transport and recording sleep."""

    transport = ScriptedTransport(responses)
    if sleep is None:
        sleep = RecordingSleep()
    cfg = config if config is not None else BASE_CONFIG
    rng = rng if rng is not None else random.Random(0)
    now = now if now is not None else (lambda: FIXED_NOW)
    client = PlatformHttpClient(
        config=cfg,
        transport=transport.transport,
        sleep=sleep,
        now=now,
        rng=rng,
    )
    return client, transport, sleep


def _resp(status: int, *, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(status, headers=headers or {})


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def test_config_defaults_are_safe() -> None:
    config = PlatformHttpConfig()

    # Timeouts are explicit and non-zero by default.
    assert config.connect_timeout == 10.0
    assert config.read_timeout == 30.0
    assert config.write_timeout == 30.0
    assert config.pool_timeout == 60.0
    # Bounded retry, jitter on, safe-methods-only by default.
    assert config.max_retries == 3
    assert config.jitter is True
    assert config.retry_non_idempotent is False
    assert config.respect_rate_limit is True
    assert config.retry_after_max_seconds == 30.0
    assert config.retryable_status_codes == set(RETRYABLE_STATUS_CODES)


def test_config_rejects_negative_timeout() -> None:
    with pytest.raises(ValidationError):
        PlatformHttpConfig(connect_timeout=-1.0)


def test_config_rejects_negative_max_retries() -> None:
    with pytest.raises(ValidationError):
        PlatformHttpConfig(max_retries=-1)


def test_config_is_frozen() -> None:
    config = PlatformHttpConfig()

    with pytest.raises((ValidationError, TypeError)):
        config.max_retries = 99  # type: ignore[misc]


def test_config_timeouts_property_builds_httpx_timeout() -> None:
    config = PlatformHttpConfig(
        connect_timeout=5.0, read_timeout=15.0, write_timeout=20.0, pool_timeout=40.0
    )
    timeout = config.timeouts

    assert isinstance(timeout, httpx.Timeout)
    assert timeout.connect == 5.0
    assert timeout.read == 15.0
    assert timeout.write == 20.0
    assert timeout.pool == 40.0


def test_config_timeouts_are_zeroable() -> None:
    # Zero timeouts are legal (caller's choice), e.g. for fast-failing tests.
    config = PlatformHttpConfig(connect_timeout=0.0)
    assert config.timeouts.connect == 0.0


# ---------------------------------------------------------------------------
# Pure classification helpers
# ---------------------------------------------------------------------------


def test_safe_methods_are_idempotent_and_writefree() -> None:
    # GET/HEAD/OPTIONS have no side effects and may always be retried.
    assert SAFE_METHODS == {"GET", "HEAD", "OPTIONS"}
    assert "POST" not in SAFE_METHODS
    assert "DELETE" not in SAFE_METHODS


@pytest.mark.parametrize(
    "status,expected",
    [
        (200, False),
        (201, False),
        (301, False),
        (400, False),
        (401, False),
        (403, False),
        (404, False),
        (422, False),
        # 500 is deliberately NOT transient (ambiguous, usually permanent).
        (500, False),
        (408, True),
        (425, True),
        (429, True),
        (502, True),
        (503, True),
        (504, True),
    ],
)
def test_is_transient_status_classification(status: int, expected: bool) -> None:
    assert is_transient_status(status) is expected


def test_transient_status_set_matches_classifier() -> None:
    # The constant and the helper must agree for every status they cover.
    for status in RETRYABLE_STATUS_CODES:
        assert is_transient_status(status) is True


def test_is_rate_limited_status() -> None:
    assert is_rate_limited_status(429) is True
    assert is_rate_limited_status(503) is False
    assert is_rate_limited_status(200) is False


@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS", "get", "head", "options"])
def test_can_retry_safe_methods_always(method: str) -> None:
    assert can_retry(method, retry_non_idempotent=False) is True


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "post"])
def test_can_retry_non_idempotent_methods_only_with_optin(method: str) -> None:
    # Without opt-in, writes/publish/delete/reply never auto-replay.
    assert can_retry(method, retry_non_idempotent=False) is False
    # Explicit opt-in (caller asserts the operation is safe to replay).
    assert can_retry(method, retry_non_idempotent=True) is True


# ---------------------------------------------------------------------------
# Backoff & Retry-After (pure, deterministic)
# ---------------------------------------------------------------------------


def test_compute_backoff_delay_is_exponential_then_capped() -> None:
    config = PlatformHttpConfig(
        backoff_base_seconds=0.5, backoff_factor=2.0, backoff_max_seconds=10.0
    )

    assert compute_backoff_delay(1, config) == 0.5
    assert compute_backoff_delay(2, config) == 1.0
    assert compute_backoff_delay(3, config) == 2.0
    assert compute_backoff_delay(4, config) == 4.0
    assert compute_backoff_delay(5, config) == 8.0
    # Capped at backoff_max_seconds even as the exponential term grows.
    assert compute_backoff_delay(6, config) == 10.0
    assert compute_backoff_delay(7, config) == 10.0


def test_compute_backoff_delay_rejects_non_positive_attempt() -> None:
    with pytest.raises(ValueError, match="attempt must be a positive integer"):
        compute_backoff_delay(0, BASE_CONFIG)


def test_retry_after_delay_parses_delta_seconds() -> None:
    assert retry_after_delay("120") == 120.0
    assert retry_after_delay("0") == 0.0
    # Whitespace and empty are ignored.
    assert retry_after_delay(None) is None
    assert retry_after_delay("") is None
    assert retry_after_delay("   ") is None


def test_retry_after_delay_parses_http_date() -> None:
    # A date 60s in the future from a fixed reference time.
    header = "Wed, 21 Oct 2026 07:29:00 GMT"
    now = datetime(2026, 10, 21, 7, 28, 0, tzinfo=UTC)

    assert retry_after_delay(header, now=now) == 60.0


def test_retry_after_delay_past_date_yields_zero() -> None:
    past = "Wed, 21 Oct 2026 07:28:00 GMT"
    now = datetime(2026, 10, 21, 7, 29, 0, tzinfo=UTC)

    assert retry_after_delay(past, now=now) == 0.0


def test_retry_after_delay_unparseable_returns_none() -> None:
    assert retry_after_delay("not-a-date-or-number") is None


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


def test_platform_http_error_holds_status_and_message() -> None:
    error = PlatformHttpError("something broke", status_code=503)

    assert error.message == "something broke"
    assert error.status_code == 503
    assert "503" in str(error)


def test_rate_limit_error_is_platform_http_error() -> None:
    error = RateLimitError("rate limited", status_code=429)

    assert isinstance(error, PlatformHttpError)
    assert error.status_code == 429


def test_transient_error_chains_cause() -> None:
    cause = ConnectionError("connection reset")

    error = TransientError("transient failure", status_code=503, cause=cause)

    assert isinstance(error, PlatformHttpError)
    assert error.__cause__ is cause
    assert error.status_code == 503


# ---------------------------------------------------------------------------
# Client: happy path & idempotency
# ---------------------------------------------------------------------------


async def test_success_returns_response_without_retry() -> None:
    client, transport, sleep = _client([_resp(200)])

    response = await client.request("GET", "https://api.example.com/posts")

    assert response.status_code == 200
    assert len(transport.requests) == 1
    assert transport.requests[0].url == "https://api.example.com/posts"
    assert transport.requests[0].method == "GET"
    assert sleep.calls == []


async def test_4xx_client_error_returns_without_retry() -> None:
    # Non-transient 4xx errors are terminal: returned, never retried.
    client, transport, sleep = _client([_resp(404)])

    response = await client.request("GET", "https://api.example.com/404")

    assert response.status_code == 404
    assert len(transport.requests) == 1
    assert sleep.calls == []


async def test_post_does_not_retry_by_default_returns_transient_response() -> None:
    # Publish/delete/reply actions must never auto-replay: a 503 on POST is
    # returned to the adapter, not retried.
    client, transport, sleep = _client([_resp(503), _resp(200)])

    response = await client.request("POST", "https://api.example.com/publish")

    assert response.status_code == 503
    assert len(transport.requests) == 1
    assert sleep.calls == []  # no retry happened


async def test_post_with_idempotent_true_retries_then_succeeds() -> None:
    # An adapter may prove a POST is safe to replay (e.g. token refresh) and
    # opt in with idempotent=True.
    client, transport, sleep = _client([_resp(503), _resp(200)])

    response = await client.request(
        "POST", "https://api.example.com/token", idempotent=True
    )

    assert response.status_code == 200
    assert len(transport.requests) == 2
    # Single retry back off once.
    assert len(sleep.calls) == 1


async def test_get_retries_on_transient_5xx_then_succeeds() -> None:
    client, transport, sleep = _client([_resp(503), _resp(503), _resp(200)])

    response = await client.request("GET", "https://api.example.com/posts")

    assert response.status_code == 200
    assert len(transport.requests) == 3
    # Two retries -> two backoff sleeps with the deterministic (jitter off)
    # exponential sequence 0.5, 1.0.
    assert sleep.calls == [0.5, 1.0]


async def test_retries_backoff_sequence_is_exponential_and_capped() -> None:
    config = PlatformHttpConfig(
        jitter=False,
        max_retries=4,
        backoff_base_seconds=0.5,
        backoff_factor=2.0,
        backoff_max_seconds=10.0,
    )
    # Four transient failures -> four retries with capped exponential backoff.
    client, transport, sleep = _client([_resp(503)] * 5, config=config)

    with pytest.raises(TransientError):
        await client.request("GET", "https://api.example.com/posts")

    assert len(transport.requests) == 5
    # Backoff for retries 1..4: 0.5, 1.0, 2.0, 4.0 (not yet capped at 10).
    assert sleep.calls == [0.5, 1.0, 2.0, 4.0]


async def test_backoff_saturates_at_max_seconds() -> None:
    config = PlatformHttpConfig(
        jitter=False,
        max_retries=3,
        backoff_base_seconds=0.5,
        backoff_factor=2.0,
        backoff_max_seconds=1.0,  # cap below the 1.0 the second retry would reach
    )
    client, _, sleep = _client([_resp(503)] * 4, config=config)

    with pytest.raises(TransientError):
        await client.request("GET", "https://api.example.com/posts")

    # Retries 1..3 capped at 1.0.
    assert sleep.calls == [0.5, 1.0, 1.0]


# ---------------------------------------------------------------------------
# Client: exhaustion & transport errors
# ---------------------------------------------------------------------------


async def test_exhausts_retries_on_persistent_5xx_raises_transient_error() -> None:
    client, transport, sleep = _client([_resp(503)] * 4)

    with pytest.raises(TransientError) as exc_info:
        await client.request("GET", "https://api.example.com/posts")

    assert exc_info.value.status_code == 503
    assert len(transport.requests) == 4  # max_retries(3) + 1
    assert len(sleep.calls) == 3  # one sleep between each retry


async def test_max_retries_zero_returns_transient_response_without_retry() -> None:
    # max_retries=0 means "do not retry": a transient response is returned as-is
    # so the adapter can decide what to do.
    client, transport, sleep = _client(
        [_resp(503)], config=PlatformHttpConfig(max_retries=0)
    )

    response = await client.request("GET", "https://api.example.com/posts")

    assert response.status_code == 503
    assert len(transport.requests) == 1
    assert sleep.calls == []


async def test_transport_error_retries_for_safe_method_then_recovers() -> None:
    error = httpx.ConnectError("connection reset by peer")
    client, transport, sleep = _client([error, error, _resp(200)])

    response = await client.request("GET", "https://api.example.com/posts")

    assert response.status_code == 200
    assert len(transport.requests) == 3
    assert sleep.calls == [0.5, 1.0]


async def test_transport_error_exhausts_for_safe_method_raises_transient() -> None:
    error = httpx.ConnectError("connection refused")
    client, transport, sleep = _client([error] * 4)

    with pytest.raises(TransientError) as exc_info:
        await client.request("GET", "https://api.example.com/posts")

    # The original transport error is chained as the cause.
    assert isinstance(exc_info.value.__cause__, httpx.ConnectError)
    assert len(transport.requests) == 4
    assert len(sleep.calls) == 3


async def test_non_retried_post_transport_error_raises_without_retry() -> None:
    # A POST that fails at the transport layer is NOT retried (we cannot know
    # whether the publish/delete/reply reached the server) and is surfaced as a
    # transient error so the adapter can ask the user before replaying.
    error = httpx.ConnectError("write failed")
    client, transport, sleep = _client([error, _resp(200)])

    with pytest.raises(TransientError) as exc_info:
        await client.request("POST", "https://api.example.com/publish")

    assert isinstance(exc_info.value.__cause__, httpx.ConnectError)
    assert len(transport.requests) == 1
    assert sleep.calls == []


# ---------------------------------------------------------------------------
# Client: rate limiting (HTTP 429)
# ---------------------------------------------------------------------------


async def test_429_with_delta_retry_after_waits_then_succeeds() -> None:
    client, transport, sleep = _client(
        [_resp(429, headers={"retry-after": "2"}), _resp(200)]
    )

    response = await client.request("GET", "https://api.example.com/posts")

    assert response.status_code == 200
    assert len(transport.requests) == 2
    # Honoured the Retry-After delta exactly.
    assert sleep.calls == [2.0]


async def test_429_with_http_date_retry_after_waits_then_succeeds() -> None:
    # FIXED_NOW is 07:28:00; the header date is 5s later -> wait 5.0s.
    header = "Wed, 21 Oct 2026 07:28:05 GMT"
    client, transport, sleep = _client(
        [_resp(429, headers={"retry-after": header}), _resp(200)],
        now=lambda: FIXED_NOW,
    )

    response = await client.request("GET", "https://api.example.com/posts")

    assert response.status_code == 200
    assert len(transport.requests) == 2
    assert sleep.calls == [5.0]


async def test_429_retry_after_exceeding_max_raises_rate_limit_error() -> None:
    config = PlatformHttpConfig(jitter=False, retry_after_max_seconds=30.0)
    # Retry-After (120s) exceeds the 30s bound -> surface a RateLimitError.
    client, transport, sleep = _client(
        [_resp(429, headers={"retry-after": "120"})], config=config
    )

    with pytest.raises(RateLimitError) as exc_info:
        await client.request("GET", "https://api.example.com/posts")

    assert exc_info.value.status_code == 429
    assert len(transport.requests) == 1
    assert sleep.calls == []  # did not wait or retry


async def test_429_without_retry_after_uses_backoff_then_raises() -> None:
    config = PlatformHttpConfig(jitter=False)
    client, transport, sleep = _client([_resp(429)] * 4, config=config)

    with pytest.raises(RateLimitError):
        await client.request("GET", "https://api.example.com/posts")

    # Four total attempts; the 429 carries no Retry-After so backoff is used.
    assert len(transport.requests) == 4
    assert sleep.calls == [0.5, 1.0, 2.0]


async def test_respect_rate_limit_disabled_returns_429_without_retry() -> None:
    config = PlatformHttpConfig(jitter=False, respect_rate_limit=False)
    client, transport, sleep = _client(
        [_resp(429, headers={"retry-after": "1"})], config=config
    )

    response = await client.request("GET", "https://api.example.com/posts")

    assert response.status_code == 429
    assert len(transport.requests) == 1
    assert sleep.calls == []


async def test_429_on_non_retried_post_returns_response() -> None:
    # A 429 on a publish (POST) is returned, not retried — writes never auto-replay.
    client, transport, sleep = _client(
        [_resp(429, headers={"retry-after": "1"})]
    )

    response = await client.request("POST", "https://api.example.com/publish")

    assert response.status_code == 429
    assert len(transport.requests) == 1
    assert sleep.calls == []


# ---------------------------------------------------------------------------
# Client: jitter & closed lifecycle
# ---------------------------------------------------------------------------


async def test_jitter_keeps_delays_within_backoff_bounds() -> None:
    config = PlatformHttpConfig(jitter=True, max_retries=3)
    client, _, sleep = _client(
        [_resp(503)] * 4, config=config, rng=random.Random(1)
    )

    with pytest.raises(TransientError):
        await client.request("GET", "https://api.example.com/posts")

    # Full jitter: each retry's delay is bounded by that retry's base backoff
    # (0.5, 1.0, 2.0 for attempts 1..3) and never negative.
    assert len(sleep.calls) == 3
    for delay, attempt in zip(sleep.calls, (1, 2, 3)):
        assert 0.0 <= delay <= compute_backoff_delay(attempt, config)


async def test_jitter_is_reproducible_with_seed() -> None:
    config = PlatformHttpConfig(jitter=True, max_retries=3)

    sleep_a = RecordingSleep()
    client_a, _, _ = _client(
        [_resp(503)] * 4, config=config, rng=random.Random(42), sleep=sleep_a
    )
    sleep_b = RecordingSleep()
    client_b, _, _ = _client(
        [_resp(503)] * 4, config=config, rng=random.Random(42), sleep=sleep_b
    )

    # Both exhaust their retry budget against identical scripted failures.
    with pytest.raises(TransientError):
        await client_a.request("GET", "https://api.example.com/posts")
    with pytest.raises(TransientError):
        await client_b.request("GET", "https://api.example.com/posts")

    # Same seed -> identical jittered delays (deterministic).
    assert sleep_a.calls == sleep_b.calls


async def test_closed_client_request_raises() -> None:
    client, _, _ = _client([_resp(200)])
    await client.aclose()

    with pytest.raises(RuntimeError, match="closed"):
        await client.request("GET", "https://api.example.com/posts")


# ---------------------------------------------------------------------------
# Client: secret safety & request forwarding
# ---------------------------------------------------------------------------


async def test_authorization_header_is_forwarded_but_not_in_errors() -> None:
    # The policy must pass the request through unchanged (including credentials
    # it is given) but never leak them into an error message.
    client, transport, _ = _client([_resp(503)] * 4)

    with pytest.raises(TransientError) as exc_info:
        await client.request(
            "GET",
            "https://api.example.com/posts",
            headers={"authorization": "Bearer secret-token-value"},
        )

    sent_header = transport.requests[0].headers.get("authorization")
    assert sent_header == "Bearer secret-token-value"
    # The error message must not echo the token.
    assert "secret-token-value" not in str(exc_info.value)
    assert "Bearer" not in str(exc_info.value)


async def test_request_forwards_params_content_and_json() -> None:
    client, transport, _ = _client([_resp(200)])

    await client.request(
        "POST",
        "https://api.example.com/publish",
        params={"fields": "id,caption"},
        headers={"x-trace": "req-1"},
        json={"text": "hello"},
        idempotent=True,
    )

    request = transport.requests[0]
    assert str(request.url).startswith("https://api.example.com/publish")
    assert request.url.params["fields"] == "id,caption"
    assert request.headers["x-trace"] == "req-1"
    # httpx encodes JSON with compact separators (no space after colons).
    assert request.content == b'{"text":"hello"}'


# ---------------------------------------------------------------------------
# Client: configuration-driven retry policy
# ---------------------------------------------------------------------------


async def test_config_retry_non_idempotent_retries_post() -> None:
    # When the policy opts in globally, POST is retried even without the
    # per-call idempotent flag.
    config = PlatformHttpConfig(jitter=False, retry_non_idempotent=True)
    client, transport, sleep = _client([_resp(503), _resp(200)], config=config)

    response = await client.request("POST", "https://api.example.com/publish")

    assert response.status_code == 200
    assert len(transport.requests) == 2
    assert len(sleep.calls) == 1


async def test_config_custom_retryable_status_codes() -> None:
    # An adapter can extend the retryable set; 404 stays non-retryable.
    config = PlatformHttpConfig(jitter=False, retryable_status_codes={418, 503})
    client, transport, _ = _client([_resp(418), _resp(200)], config=config)

    response = await client.request("GET", "https://api.example.com/teapot")

    assert response.status_code == 200
    assert len(transport.requests) == 2


async def test_idempotent_false_override_never_retries_even_get() -> None:
    config = PlatformHttpConfig(jitter=False)
    client, transport, sleep = _client([_resp(503), _resp(200)], config=config)

    # Explicit override forces a single attempt regardless of method.
    response = await client.request(
        "GET", "https://api.example.com/posts", idempotent=False
    )

    assert response.status_code == 503
    assert len(transport.requests) == 1
    assert sleep.calls == []


# ---------------------------------------------------------------------------
# Client: end-to-end reuse as a shared platform primitive
# ---------------------------------------------------------------------------


async def test_shared_client_serves_multiple_methods_deterministically() -> None:
    # One client instance is reused across GET and POST (read/write), the core
    # requirement: a single tested primitive shared by adapters.
    client, transport, sleep = _client([_resp(200), _resp(200)])

    await client.request("GET", "https://api.example.com/me")
    await client.request(
        "POST", "https://api.example.com/publish", idempotent=True
    )

    assert [r.method for r in transport.requests] == ["GET", "POST"]
    # Both succeeded with no retries.
    assert sleep.calls == []


async def test_client_is_async_context_manager() -> None:
    config = PlatformHttpConfig(jitter=False)
    async with PlatformHttpClient(
        config=config, transport=httpx.MockTransport(lambda r: _resp(200))
    ) as client:
        response = await client.request("GET", "https://api.example.com/ok")
        assert response.status_code == 200
