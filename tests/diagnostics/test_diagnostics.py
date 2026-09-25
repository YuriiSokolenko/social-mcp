"""Tests for operational diagnostics: bounded retention, redaction, correlation,
and the admin logs view.

These tests cover the acceptance criteria for issue #24:

* useful recent application/API error/status information in Web Admin;
* redact tokens, authorization codes, app secrets and sensitive headers;
* bounded retention suitable for the N150 deployment;
* platform/API request correlation where useful;
* no social-content logging by default unless required for troubleshooting.

No real credentials or external social APIs are involved.
"""

from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

from social_mcp.app import create_app
from social_mcp.diagnostics import (
    DiagnosticLevel,
    DiagnosticLog,
    DiagnosticLogFilter,
    Redactor,
    current_request_id,
    get_diagnostics,
    request_id_var,
    set_request_id,
)

ADMIN_AUTH = ("admin", "example-secret")
ADMIN_SESSION_SECRET = "test-session-secret-not-for-production-use"

DEFAULT_MAX_EVENTS_TEST = 5


def _make_log(max_events: int = DEFAULT_MAX_EVENTS_TEST) -> DiagnosticLog:
    """Build a fresh, isolated DiagnosticLog for testing."""

    return DiagnosticLog(max_events=max_events)


# --- Bounded retention ------------------------------------------------------


def test_diagnostic_log_retains_only_the_most_recent_events() -> None:
    log = _make_log(max_events=3)

    for i in range(10):
        log.record(DiagnosticLevel.INFO, source="t", message=f"event-{i}")

    events = log.recent()
    assert len(events) == 3
    assert events[-1].message == "event-9"
    assert events[0].message == "event-7"


def test_recent_returns_a_copy_that_cannot_mutate_the_buffer() -> None:
    log = _make_log(max_events=3)
    log.record(DiagnosticLevel.INFO, source="t", message="a")

    events = log.recent()
    events.clear()

    assert len(log) == 1


def test_clear_removes_all_events() -> None:
    log = _make_log()
    log.record(DiagnosticLevel.INFO, source="t", message="a")
    log.record(DiagnosticLevel.INFO, source="t", message="b")

    assert log.clear() == 2
    assert len(log) == 0
    assert log.recent() == []


def test_diagnostic_log_rejects_a_non_positive_max_events() -> None:
    with pytest.raises(ValueError, match="max_events"):
        DiagnosticLog(max_events=0)


def test_field_truncation_bounds_large_messages() -> None:
    log = DiagnosticLog(max_events=5, field_limit=20)
    long_message = "x" * 100

    event = log.record(DiagnosticLevel.INFO, source="t", message=long_message)

    assert len(event.message) == 20
    assert event.message.endswith("\u2026")


def test_truncation_only_applies_when_over_the_limit() -> None:
    log = DiagnosticLog(max_events=5, field_limit=100)
    short = "short"

    event = log.record(DiagnosticLevel.INFO, source="t", message=short)

    assert event.message == short


def test_detail_is_truncated_and_none_by_default() -> None:
    log = DiagnosticLog(max_events=5, field_limit=10)

    event = log.record(DiagnosticLevel.ERROR, source="t", message="boom")
    assert event.detail is None

    event_with_detail = log.record(
        DiagnosticLevel.ERROR, source="t", message="boom", detail="y" * 100
    )
    assert len(event_with_detail.detail or "") == 10


# --- record helpers ----------------------------------------------------------


def test_record_http_classifies_5xx_as_error_and_others_as_info() -> None:
    log = _make_log()

    log.record_http("threads-adapter", "threads", "/v1/posts", status_code=500)
    log.record_http("threads-adapter", "threads", "/v1/posts", status_code=200)

    events = log.recent()
    assert events[0].level == DiagnosticLevel.ERROR
    assert events[1].level == DiagnosticLevel.INFO
    assert events[0].status_code == 500
    assert events[1].endpoint == "/v1/posts"


def test_record_error_captures_type_and_message_without_full_chain() -> None:
    log = _make_log()
    error = RuntimeError("something failed")

    event = log.record_error("threads-adapter", error)

    assert event.level == DiagnosticLevel.ERROR
    assert event.message == "operation failed"
    assert "RuntimeError" in event.detail
    assert "something failed" in event.detail


def test_record_http_does_not_capture_response_bodies() -> None:
    """No social content is logged: only metadata is retained."""

    log = _make_log()
    log.record_http("threads-adapter", "threads", "/v1/me", status_code=200)

    event = log.recent()[0]
    assert event.platform == "threads"
    assert event.endpoint == "/v1/me"
    assert event.status_code == 200
    for field_name in ("body", "response_body", "content"):
        assert not hasattr(event, field_name)


# --- Redaction ---------------------------------------------------------------


def test_redactor_redacts_bearer_and_basic_credentials() -> None:
    redactor = Redactor()

    assert redactor.redact("Bearer abc123.secret") == "Bearer REDACTED"
    assert redactor.redact("Basic dXNlcjpwYXNz") == "Basic REDACTED"
    assert redactor.redact("not-a-credential") == "not-a-credential"


def test_redactor_redacts_sensitive_headers() -> None:
    redactor = Redactor()
    headers = {
        "Authorization": "Bearer mg2...abc",
        "X-API-Key": "secret-key",
        "Content-Type": "application/json",
        "Set-Cookie": "session=abc",
    }

    redacted = redactor.redact_headers(headers)

    assert redacted["Authorization"] == "REDACTED"
    assert redacted["X-API-Key"] == "REDACTED"
    assert redacted["Set-Cookie"] == "REDACTED"
    assert redacted["Content-Type"] == "application/json"


def test_redactor_redacts_sensitive_fields_recursively() -> None:
    redactor = Redactor()
    payload = {
        "access_token": "tok-123",
        "refresh_token": "rtk-456",
        "authorization_code": "code-789",
        "client_secret": "shh",
        "user": {"name": "alice", "email": "a@x.com"},
        "meta_app_secret": "secret",
        "nested": {"token": "deep-token"},
        "list": [{"password": "pw"}, "ok"],
    }

    redacted = redactor.redact_fields(payload)

    assert redacted["access_token"] == "REDACTED"
    assert redacted["refresh_token"] == "REDACTED"
    assert redacted["authorization_code"] == "REDACTED"
    assert redacted["client_secret"] == "REDACTED"
    assert redacted["meta_app_secret"] == "REDACTED"
    assert redacted["user"] == {"name": "alice", "email": "a@x.com"}
    assert redacted["nested"] == {"token": "REDACTED"}
    assert redacted["list"] == [{"password": "REDACTED"}, "ok"]


def test_redactor_preserves_non_string_values() -> None:
    redactor = Redactor()
    payload = {"count": 3, "active": True, "name": "alice"}

    assert redactor.redact_fields(payload) == payload


def test_sensitive_key_matching_is_case_insensitive_and_suffix_based() -> None:
    redactor = Redactor()

    assert redactor.redact_fields({"Authorization": "x"}) == {"Authorization": "REDACTED"}
    assert redactor.redact_fields({"x_refresh_token": "x"}) == {"x_refresh_token": "REDACTED"}


# --- Request correlation -----------------------------------------------------


def test_set_and_get_request_id_round_trips() -> None:
    token = set_request_id("req-123")
    try:
        assert current_request_id() == "req-123"
    finally:
        request_id_var.reset(token)


def test_request_id_is_none_by_default() -> None:
    assert current_request_id() is None


# --- DiagnosticLogFilter attaches correlation ids ----------------------------


def test_log_filter_records_events_with_correlation_id(caplog) -> None:
    shared = get_diagnostics()
    shared.clear()

    logger = logging.getLogger("social_mcp.diagnostics.test_filter")
    logger.addFilter(DiagnosticLogFilter())

    set_request_id("corr-1")
    try:
        with caplog.at_level(logging.INFO, logger="social_mcp.diagnostics.test_filter"):
            logger.info("hello world")
    finally:
        set_request_id(None)

    events = [
        e for e in shared.recent() if e.source == "social_mcp.diagnostics.test_filter"
    ]
    assert any(e.message == "hello world" and e.correlation_id == "corr-1" for e in events)


# --- Admin logs route --------------------------------------------------------


@pytest.fixture()
def admin_app(tmp_path, make_settings):
    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
        )
    )
    with TestClient(app) as client:
        client.post("/admin/login", auth=ADMIN_AUTH)
        yield app, client


def _csrf(client: TestClient) -> str:
    import re

    response = client.post("/admin/login", auth=ADMIN_AUTH)
    match = re.search(r"value='([^']+)'", response.text)
    assert match is not None
    return match.group(1)


def test_logs_route_shows_no_events_when_empty(admin_app) -> None:
    _, client = admin_app

    response = client.get("/admin/logs")

    assert response.status_code == 200
    assert "No recent diagnostic events." in response.text


def test_logs_route_renders_events_with_fields(admin_app) -> None:
    app, client = admin_app
    app.state.container.diagnostics.record(
        DiagnosticLevel.ERROR,
        source="threads-adapter",
        message="platform API request failed",
        correlation_id="corr-1",
        platform="threads",
        endpoint="/v1/posts",
        status_code=500,
        detail="RuntimeError: failed",
    )

    response = client.get("/admin/logs")

    assert response.status_code == 200
    body = response.text
    assert "threads-adapter" in body
    assert "corr-1" in body
    assert "threads" in body
    assert "/v1/posts" in body
    assert "500" in body
    assert "platform API request failed" in body
    assert "RuntimeError" in body


def test_logs_route_shows_error_rows_with_a_distinct_class(admin_app) -> None:
    app, client = admin_app
    app.state.container.diagnostics.record(
        DiagnosticLevel.ERROR, source="s", message="boom"
    )

    body = client.get("/admin/logs").text

    assert "<tr class='error'>" in body


def test_logs_route_never_exposes_token_values(admin_app) -> None:
    """A token placed in a sensitive field, redacted before recording, is
    replaced by the redaction marker and never rendered."""

    app, client = admin_app
    redactor = Redactor()
    redacted = redactor.redact_fields({"refresh_token": "super-secret-value"})
    app.state.container.diagnostics.record(
        DiagnosticLevel.WARNING,
        source="auth",
        message="token refresh",
        detail=str(redacted),
    )

    body = client.get("/admin/logs").text

    assert "super-secret-value" not in body


def test_logs_page_has_admin_navigation(admin_app) -> None:
    _, client = admin_app

    body = client.get("/admin/logs").text

    assert "/admin/logs" in body
    assert "/admin/dashboard" in body
    assert "/admin/accounts" in body
    assert "/admin/logout" in body


def test_logs_clear_action_clears_events_with_csrf(admin_app) -> None:
    app, client = admin_app
    app.state.container.diagnostics.record(
        DiagnosticLevel.ERROR, source="s", message="boom"
    )
    token = _csrf(client)

    response = client.post("/admin/logs/clear", headers={"x-csrf-token": token})

    assert response.status_code == 200
    assert "Logs cleared." in response.text
    assert "<tr" not in client.get("/admin/logs").text


def test_logs_clear_without_csrf_is_rejected(admin_app) -> None:
    _, client = admin_app

    response = client.post("/admin/logs/clear")

    assert response.status_code == 403


def test_logs_route_rejects_anonymous_access(tmp_path, make_settings) -> None:
    app = create_app(
        make_settings(
            tmp_path,
            admin_username="admin",
            admin_password="example-secret",
            admin_session_secret=ADMIN_SESSION_SECRET,
        )
    )
    with TestClient(app) as client:
        response = client.get("/admin/logs", follow_redirects=False)

    assert response.status_code == 303
    assert response.headers["location"] == "/admin/login"


def test_logs_route_is_unavailable_without_configuration(tmp_path, make_settings) -> None:
    app = create_app(make_settings(tmp_path, admin_session_secret=None))

    with TestClient(app) as client:
        response = client.get("/admin/logs", follow_redirects=False)

    assert response.status_code == 503


def test_logs_route_is_not_cacheable(admin_app) -> None:
    _, client = admin_app

    response = client.get("/admin/logs")

    assert response.headers["cache-control"] == "no-store"


# --- Request correlation is emitted on responses -----------------------------


def test_responses_carry_a_correlation_id_header(tmp_path, make_settings) -> None:
    app = create_app(make_settings(tmp_path))

    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert "x-correlation-id" in response.headers
    correlation_id = response.headers["x-correlation-id"]
    assert len(correlation_id) == 12
    assert all(c in "0123456789abcdef" for c in correlation_id)


def test_unhealthy_request_logs_error_with_correlation_id(tmp_path, make_settings) -> None:
    """An error logged during a request carries the response correlation id.

    The /health handler logs an error when the account store is unreachable;
    that error must be captured in the bounded log tagged with the same
    correlation id the client sees on the response header, proving the id is
    bound for the duration of the request including error paths.
    """

    app = create_app(make_settings(tmp_path))
    shared = get_diagnostics()
    shared.clear()

    with TestClient(app) as client:
        app.state.container.account_store.database_path = (
            app.state.container.account_store.database_path.parent / "gone" / "db.sqlite3"
        )
        response = client.get("/health")
        error_id = response.headers.get("x-correlation-id")

    assert response.status_code == 503
    assert error_id is not None
    matching = [
        e for e in shared.recent()
        if e.source == "social_mcp" and e.level == DiagnosticLevel.ERROR
    ]
    assert any(e.correlation_id == error_id for e in matching), (
        "expected an error logged during the unhealthy /health request to "
        "carry the response correlation id"
    )
