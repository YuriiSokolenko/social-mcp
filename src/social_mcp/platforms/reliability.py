"""Shared HTTP reliability policy for official social-platform adapters.

This module provides one reusable, platform-neutral transport/reliability
primitive that the Threads and TikTok adapters share: explicit connect/read/
write/pool timeouts, bounded retry with exponential backoff for safe
transient failures, HTTP 429 rate-limit handling with a bounded ``Retry-After``
wait, transient 5xx classification, and idempotency-aware retrying so that
non-idempotent publish/delete/reply actions are **never** replayed
automatically unless an adapter has explicitly opted in and proven the
operation safe.

Design rules

* **Safe defaults.** By default only *safe* methods (``GET``, ``HEAD``,
  ``OPTIONS``) are retried. ``POST``/``PUT``/``PATCH``/``DELETE`` are never
  retried unless an adapter calls :meth:`PlatformHttpClient.request` with
  ``idempotent=True`` — which it may do only for operations it has proven safe
  to replay (e.g. token refresh). This is the contract that fulfils "never
  automatically replay non-idempotent publish/delete/reply actions".
* **No new service.** This is a library-level primitive. It performs no
  periodic background work and no scheduled polling.
* **No production credentials.** The module never reads, stores, logs or
  forwards tokens, secret keys, cookies or authorization headers. Adapters
  supply credentials through the request they build; this policy only moves
  bytes. Requests/responses are not logged beyond status codes.
* **Deterministic in tests.** The network boundary, sleep, clock and jitter
  source are injectable, so every behaviour is exercised with mocked
  providers and no real network or wall-clock waits.
"""

from __future__ import annotations

import asyncio
import email.utils
import logging
import random
from collections.abc import Awaitable, Callable, Mapping
from datetime import UTC, datetime
from typing import Any, Self

import httpx
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

__all__ = [
    "RETRYABLE_STATUS_CODES",
    "SAFE_METHODS",
    "PlatformHttpClient",
    "PlatformHttpConfig",
    "PlatformHttpError",
    "RateLimitError",
    "TransientError",
    "can_retry",
    "compute_backoff_delay",
    "is_rate_limited_status",
    "is_transient_status",
    "retry_after_delay",
]


# ---------------------------------------------------------------------------
# HTTP method / status classification
# ---------------------------------------------------------------------------

#: HTTP methods with no side effects on the server. These are safe to retry
#: automatically because replaying them after a transient failure cannot change
#: account state — this is the core of the "never auto-replay writes" contract.
SAFE_METHODS: frozenset[str] = frozenset({"GET", "HEAD", "OPTIONS"})

#: HTTP status codes classified as transient failures worth retrying *when the
#: method is safe to retry*. Covers request timeouts (408), "too early" (425),
#: rate limiting (429) and the upstream/gateway failures 502/503/504.
#:
#: ``500 Internal Server Error`` is intentionally **not** included: it is
#: ambiguous and typically reflects a permanent server-side bug rather than a
#: transient blip, so retrying it automatically is unlikely to help.
RETRYABLE_STATUS_CODES: frozenset[int] = frozenset({408, 425, 429, 502, 503, 504})


def is_transient_status(status_code: int) -> bool:
    """Return whether ``status_code`` is a transient, retryable failure.

    The classification is deliberately conservative: only 408, 425, 429 and
    502/503/504 are considered transient. 500 is excluded because it is
    ambiguous and usually permanent; 4xx client errors (other than 408) are
    never retried. The full set lives in :data:`RETRYABLE_STATUS_CODES`.
    """

    return status_code in RETRYABLE_STATUS_CODES


def is_rate_limited_status(status_code: int) -> bool:
    """Return whether ``status_code`` is an HTTP 429 rate-limit response."""

    return status_code == 429


def can_retry(method: str, *, retry_non_idempotent: bool) -> bool:
    """Decide whether ``method`` may be retried under a given policy.

    Args:
        method: The HTTP method (matched case-insensitively).
        retry_non_idempotent: Whether the policy opts in to retrying
            non-idempotent/stateful methods. This is the explicit "I have
            proven this operation safe to replay" switch that adapters set per
            call or in config.

    Returns:
        ``True`` for safe methods (always) and for non-idempotent methods only
        when ``retry_non_idempotent`` is ``True``.
    """

    if method.upper() in SAFE_METHODS:
        return True
    return retry_non_idempotent


# ---------------------------------------------------------------------------
# Backoff & rate-limit helpers (pure, deterministic)
# ---------------------------------------------------------------------------


def compute_backoff_delay(attempt: int, config: PlatformHttpConfig) -> float:
    """Return the capped exponential backoff delay for retry ``attempt``.

    ``attempt`` is 1-indexed (the first retry is attempt 1). The delay is

    ``min(backoff_max, backoff_base * backoff_factor ** (attempt - 1))``

    This is the base value **before** jitter; jitter is applied separately by
    the client using an injectable random source so tests stay deterministic.

    Raises:
        ValueError: if ``attempt`` is not a positive integer.
    """

    if attempt < 1:
        raise ValueError(f"attempt must be a positive integer, got {attempt}")
    exponent = config.backoff_factor ** (attempt - 1)
    delay = config.backoff_base_seconds * exponent
    return min(delay, config.backoff_max_seconds)


def retry_after_delay(
    header: str | None,
    now: datetime | None = None,
) -> float | None:
    """Parse an HTTP ``Retry-After`` header into seconds to wait.

    Supports both forms from RFC 7231:

    * ``delta-seconds`` (e.g. ``"120"``); and
    * ``HTTP-date`` (e.g. ``"Wed, 21 Oct 2026 07:28:00 GMT"``).

    Args:
        header: The raw ``Retry-After`` header value, or ``None``/empty.
        now: The reference time for the HTTP-date form. Defaults to the current
            UTC time; inject an explicit value for deterministic tests.

    Returns:
        Whole seconds to wait, or ``None`` when the header is absent or
        unparseable. A parsed past date yields ``0.0`` (retry immediately).
    """

    if not header:
        return None
    text = header.strip()
    if not text:
        return None
    if text.isdigit():
        return float(text)
    try:
        parsed = email.utils.parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return None
    if parsed is None:
        return None
    # ``parsedate_to_datetime`` may return a naive datetime for a date string
    # without timezone information; treat such values as UTC so they always
    # compare cleanly against the (timezone-aware) reference.
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    reference = now if now is not None else datetime.now(UTC)
    delta = (parsed - reference).total_seconds()
    return max(0.0, delta)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


class PlatformHttpConfig(BaseModel):
    """Policy parameters for :class:`PlatformHttpClient`.

    A frozen, validated value object: build one (with defaults or overrides)
    and share it across adapters. Defaults are deliberately conservative so a
    freshly constructed client is safe to use against either platform.

    Timeouts are in seconds. Retry parameters bound the total backoff. Rate-
    limit parameters bound how long the client will wait on a 429 before
    surfacing the failure to the adapter.
    """

    model_config = ConfigDict(frozen=True)

    # --- timeouts --------------------------------------------------------
    connect_timeout: float = Field(default=10.0, ge=0)
    read_timeout: float = Field(default=30.0, ge=0)
    write_timeout: float = Field(default=30.0, ge=0)
    pool_timeout: float = Field(default=60.0, ge=0)

    # --- retry budget ----------------------------------------------------
    #: Maximum retries *after* the initial attempt. Total attempts are at most
    #: ``max_retries + 1``. Zero disables retrying entirely (each transient
    #: failure is surfaced on the first attempt).
    max_retries: int = Field(default=3, ge=0)
    #: Base backoff in seconds; retry ``n`` waits
    #: ``min(backoff_max, backoff_base * backoff_factor ** (n - 1))``.
    backoff_base_seconds: float = Field(default=0.5, ge=0)
    backoff_factor: float = Field(default=2.0, ge=0)
    backoff_max_seconds: float = Field(default=10.0, ge=0)
    #: Whether to add full-jitter to backoff sleeps so concurrent clients
    #: desynchronize instead of amplifying a spike.
    jitter: bool = True

    # --- rate limiting ---------------------------------------------------
    #: Whether to honour ``Retry-After`` on a 429 before retrying.
    respect_rate_limit: bool = True
    #: Upper bound on a ``Retry-After`` wait that the client will honour. A
    #: header asking for longer causes the client to surface a
    #: :class:`RateLimitError` instead of guessing.
    retry_after_max_seconds: float = Field(default=30.0, ge=0)

    # --- idempotency -----------------------------------------------------
    #: Default retry policy for non-idempotent/stateful methods. ``False`` by
    #: default so publish/delete/reply actions are never replayed unless an
    #: adapter opts in per call via ``idempotent=True``.
    retry_non_idempotent: bool = False

    #: Status codes treated as worth retrying. Defaults to the transient set
    #: (see :data:`RETRYABLE_STATUS_CODES`); adapters may extend or shrink it.
    retryable_status_codes: set[int] = Field(
        default_factory=lambda: set(RETRYABLE_STATUS_CODES)
    )

    @property
    def timeouts(self) -> httpx.Timeout:
        """The httpx timeout object configured from this policy."""

        return httpx.Timeout(
            connect=self.connect_timeout,
            read=self.read_timeout,
            write=self.write_timeout,
            pool=self.pool_timeout,
        )


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class PlatformHttpError(Exception):
    """Base class for failures surfaced by the reliability policy.

    Subclasses carry a ``status_code`` (when a response exists) and a safe,
    secret-free message. Adapters map these to the normalized MCP error
    categories (e.g. ``temporary_failure`` / ``rate_limited``).
    """

    status_code: int | None

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message

    def __str__(self) -> str:  # pragma: no cover - trivial
        base = self.message
        if self.status_code is not None:
            base = f"HTTP {self.status_code}: {base}"
        return base


class RateLimitError(PlatformHttpError):
    """Raised when an HTTP 429 could not be honoured within bounds.

    This happens when retries are exhausted on a 429, when the method is not
    being retried, or when the ``Retry-After`` delay exceeds
    :attr:`PlatformHttpConfig.retry_after_max_seconds`. The adapter surfaces it
    as the ``rate_limited`` MCP category.
    """


class TransientError(PlatformHttpError):
    """Raised when a transient failure (5xx/timeout/network) exhausted retries.

    The request may have reached the server; adapters that retry non-idempotent
    operations must treat this as "in-flight" and confirm via an idempotent
    read before replaying. Maps to the ``temporary_failure`` MCP category.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message, status_code=status_code)
        self.__cause__ = cause


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

#: A callable that sleeps for ``seconds``. Defaults to :func:`asyncio.sleep`;
#: tests inject a recording stand-in so behaviour is deterministic and fast.
SleepFn = Callable[[float], Awaitable[None]]


async def _default_sleep(seconds: float) -> None:
    """Default sleep used when no injectable sleep is supplied."""

    await asyncio.sleep(seconds)


class PlatformHttpClient:
    """A shared, retry-aware httpx client for platform adapters.

    Build once with a :class:`PlatformHttpConfig` (defaults are safe) and share
    across the Threads and TikTok adapters. The network transport, sleep,
    clock and jitter source are injectable so every reliability behaviour is
    unit-testable with mocked providers and no real network or wall-clock
    waits.

    Context manager::

        async with PlatformHttpClient(config) as client:
            response = await client.request("GET", url, headers=headers)
    """

    def __init__(
        self,
        config: PlatformHttpConfig | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: SleepFn | None = None,
        now: Callable[[], datetime] | None = None,
        rng: random.Random | None = None,
    ) -> None:
        self._config = config if config is not None else PlatformHttpConfig()
        self._sleep: SleepFn = sleep if sleep is not None else _default_sleep
        self._now: Callable[[], datetime] = now if now is not None else _now_utc
        self._rng = rng if rng is not None else random.Random()
        # Build the underlying httpx client. ``transport=None`` selects httpx's
        # default real transport; tests pass an :class:`httpx.MockTransport`.
        self._client = httpx.AsyncClient(
            transport=transport,
            timeout=self._config.timeouts,
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=10),
        )
        self._closed = False

    # -- lifecycle --------------------------------------------------------

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Close the underlying httpx client and release connections."""

        self._closed = True
        await self._client.aclose()

    def _check_active(self) -> None:
        if self._closed:
            raise RuntimeError("PlatformHttpClient has been closed.")

    # -- public API -------------------------------------------------------

    @property
    def config(self) -> PlatformHttpConfig:
        """The policy this client was built with."""

        return self._config

    async def request(
        self,
        method: str,
        url: str | httpx.URL,
        *,
        headers: Mapping[str, str] | None = None,
        params: httpx.QueryParams | Mapping[str, str] | None = None,
        content: str | bytes | None = None,
        data: str | bytes | Mapping[str, str] | None = None,
        json: Any = None,
        idempotent: bool | None = None,
    ) -> httpx.Response:
        """Send a request applying the reliability policy.

        Args:
            method: HTTP method.
            url: Target URL.
            headers, params, content, data, json: Forwarded to httpx. Secrets
                are never logged by this policy; only request metadata may be
                surfaced on failure.
            idempotent: Retry-control for the *method* of this call:
                - ``None`` (default): retry safe methods (and, if config
                  opts in, non-idempotent ones).
                - ``True``: retry this call on transient failures — the caller
                  asserts the operation is safe to replay.
                - ``False``: never retry this call (single attempt); transport
                  errors are surfaced as :class:`TransientError` because no
                  response exists to return.

        Returns:
            The final :class:`httpx.Response` for accepted responses.

        Raises:
            TransientError: a transient failure (5xx/timeout/network) persisted
                past the retry budget.
            RateLimitError: an HTTP 429 could not be honoured within bounds.
        """

        self._check_active()
        method = method.upper()
        retry_allowed = self._resolve_retry_allowed(method, idempotent)
        attempt = 0
        while True:
            attempt += 1
            try:
                response = await self._send(
                    method,
                    url,
                    headers=headers,
                    params=params,
                    content=content,
                    data=data,
                    json_body=json,
                )
            except httpx.RequestError as exc:
                # No response: the request never completed. Safe methods retry
                # (and exhaust into TransientError). Non-retried methods raise
                # immediately — for a write we cannot know if it succeeded.
                if retry_allowed and attempt <= self._config.max_retries:
                    self._log_retry(method, reason="network-error", attempt=attempt, exc=exc)
                    await self._sleep(self._backoff_for(attempt))
                    continue
                raise TransientError(
                    "platform request failed after retries",
                    cause=exc,
                ) from exc

            decision, wait = self._classify_response(method, response, attempt, retry_allowed)
            if decision == "return":
                return response
            if decision == "rate_limit":
                raise RateLimitError(
                    "rate limit could not be honoured within bounds",
                    status_code=response.status_code,
                )
            if decision == "transient_exhausted":
                raise TransientError(
                    "transient failure persisted past the retry budget",
                    status_code=response.status_code,
                )
            # decision == "retry"
            self._log_retry(method, reason="transient", attempt=attempt, status=response.status_code)
            await self._sleep(wait)

    # -- internals --------------------------------------------------------

    def _resolve_retry_allowed(self, method: str, idempotent: bool | None) -> bool:
        if idempotent is True:
            return True
        if idempotent is False:
            return False
        # Default: safe methods always; others only if config opts in.
        return method in SAFE_METHODS or self._config.retry_non_idempotent

    def _backoff_for(self, attempt: int) -> float:
        delay = compute_backoff_delay(attempt, self._config)
        if self._config.jitter:
            # Full jitter: uniform in [0, delay]. Inject ``rng`` for tests.
            return self._rng.uniform(0.0, delay)
        return delay

    async def _send(
        self,
        method: str,
        url: str | httpx.URL,
        *,
        headers: Mapping[str, str] | None,
        params: httpx.QueryParams | Mapping[str, str] | None,
        content: str | bytes | None,
        data: str | bytes | Mapping[str, str] | None,
        json_body: Any,
    ) -> httpx.Response:
        kwargs: dict[str, Any] = {}
        if headers is not None:
            kwargs["headers"] = headers
        if params is not None:
            kwargs["params"] = params
        if content is not None:
            kwargs["content"] = content
        if data is not None:
            kwargs["data"] = data
        if json_body is not None:
            kwargs["json"] = json_body
        return await self._client.request(method, url, **kwargs)

    def _classify_response(
        self,
        method: str,
        response: httpx.Response,
        attempt: int,
        retry_allowed: bool,
    ) -> tuple[str, float]:
        """Decide what to do with a received response.

        Returns ``(decision, wait)`` where decision is one of:

        * ``"return"`` — hand the response to the caller.
        * ``"retry"``   — sleep ``wait`` seconds and retry.
        * ``"rate_limit"`` — raise :class:`RateLimitError` (429).
        * ``"transient_exhausted"`` — raise :class:`TransientError` (5xx after
          the client committed to retrying and the budget is used up).

        Consistency rule for exhaustion: the client only *raises* on a failure
        it actually committed to retrying (a safe method with ``max_retries``
        ``>= 1``). A single-attempt call (``max_retries == 0``) or a non-retried
        method (``retry_allowed`` is ``False``) simply returns the response so
        the adapter sees the server's answer and decides. ``429`` is always
        handled by the dedicated rate-limit branch, even when it also appears in
        the retryable set.
        """

        status = response.status_code
        retryable = self._config.retryable_status_codes
        # Whether the policy committed to at least one retry for this call.
        committed = retry_allowed and self._config.max_retries >= 1
        exhausted = attempt > self._config.max_retries

        # 429 rate limiting -------------------------------------------------
        if is_rate_limited_status(status):
            if not retry_allowed or not self._config.respect_rate_limit:
                return "return", 0.0
            wait = self._rate_limit_wait(response)
            if wait is None:
                # No usable Retry-After: back off if retries remain.
                if retry_allowed and not exhausted:
                    return "retry", self._backoff_for(attempt)
                if committed and exhausted:
                    return "rate_limit", 0.0
                return "return", 0.0
            if wait > self._config.retry_after_max_seconds:
                # The provider asked to wait longer than we will guess.
                return "rate_limit", 0.0
            if retry_allowed and not exhausted:
                return "retry", wait
            if committed and exhausted:
                return "rate_limit", 0.0
            return "return", 0.0

        # Transient 5xx / 408 / 425 (and any custom retryable code) ---------
        if status in retryable:
            if retry_allowed and not exhausted:
                return "retry", self._backoff_for(attempt)
            if committed and exhausted:
                return "transient_exhausted", 0.0
            return "return", 0.0

        # Everything else (2xx, 3xx, 4xx non-429, etc.) is terminal.
        return "return", 0.0

    def _rate_limit_wait(self, response: httpx.Response) -> float | None:
        """Seconds to wait for a 429, honouring ``Retry-After`` if present.

        Delegates to :func:`retry_after_delay`, which resolves HTTP-date values
        against the client's injectable ``now`` so tests stay deterministic.
        Only the response's ``Retry-After`` header is consulted; no body or
        credentials are read.
        """

        header = response.headers.get("retry-after")
        if header:
            delay = retry_after_delay(header, now=self._now())
            if delay is not None:
                return delay
        return None

    def _log_retry(
        self,
        method: str,
        *,
        reason: str,
        attempt: int,
        exc: BaseException | None = None,
        status: int | None = None,
    ) -> None:
        """Log retry intent without exposing any credentials or bodies.

        Only the method, attempt count, a reason keyword and (for responses) the
        status code are recorded. ``exc`` and ``status`` are never printed with
        secrets, and no request/response bodies are logged by this policy.
        """

        detail = f"method={method} attempt={attempt} reason={reason}"
        if status is not None:
            detail += f" status={status}"
        elif exc is not None:
            detail += f" error={type(exc).__name__}"
        logger.debug("platform retry: %s", detail)


def _now_utc() -> datetime:
    """Default reference time used when no injectable ``now`` is supplied.

    Used only to resolve HTTP-date ``Retry-After`` values; tests inject a fixed
    ``now`` so rate-limit behaviour is deterministic. Backoff sleeps use the
    injectable ``sleep`` callable, not wall-clock time.
    """

    return datetime.now(UTC)
