"""Tests for the smoke workflow redaction helper."""

from __future__ import annotations

import copy

from social_mcp.diagnostics.smoke_redact import redact_mapping


def test_redacts_default_sensitive_keys() -> None:
    redacted = redact_mapping({"token": "abc123", "note": "kept"})

    assert redacted == {"token": "***", "note": "kept"}


def test_redacts_nested_structures() -> None:
    payload = {
        "request": {
            "headers": {"authorization": "Bearer secret", "accept": "application/json"},
            "body": {"nested": {"api_key": "keep-me", "password": "hunter2"}},
        },
        "meta": ["plain", {"token": "t0p"}],
    }

    assert redact_mapping(payload) == {
        "request": {
            "headers": {"authorization": "***", "accept": "application/json"},
            "body": {"nested": {"api_key": "keep-me", "password": "***"}},
        },
        "meta": ["plain", {"token": "***"}],
    }


def test_redacts_repeated_keys_inside_lists() -> None:
    payload = {"items": [{"secret": "one"}, {"visible": 1, "secret": "two"}]}

    assert redact_mapping(payload) == {
        "items": [{"secret": "***"}, {"visible": 1, "secret": "***"}]
    }


def test_redacts_lists_of_lists() -> None:
    payload = {"items": ["a", ["b", {"password": "c"}, 7]]}

    assert redact_mapping(payload) == {"items": ["a", ["b", {"password": "***"}, 7]]}


def test_matches_keys_case_insensitively() -> None:
    payload = {"Authorization": "a", "AUTHORIZATION": "b", "TOKEN": "c", "Token": "d"}

    assert redact_mapping(payload) == {
        "Authorization": "***",
        "AUTHORIZATION": "***",
        "TOKEN": "***",
        "Token": "***",
    }


def test_key_must_match_exactly_ignoring_case() -> None:
    payload = {"tokens": "not-sensitive", "token_count": 3, "token": "secret"}

    assert redact_mapping(payload) == {
        "tokens": "not-sensitive",
        "token_count": 3,
        "token": "***",
    }


def test_supports_custom_sensitive_keys_and_replacement() -> None:
    payload = {"api_key": "abc", "name": "service", "inner": {"api_key": "xyz"}}

    redacted = redact_mapping(payload, sensitive_keys={"api_key"}, replacement="[REDACTED]")

    assert redacted == {
        "api_key": "[REDACTED]",
        "name": "service",
        "inner": {"api_key": "[REDACTED]"},
    }


def test_leaves_non_matching_scalars_unchanged() -> None:
    payload = {"count": 3, "ratio": 1.5, "flag": True, "missing": None, "text": "hello"}

    assert redact_mapping(payload) == payload


def test_does_not_mutate_input() -> None:
    payload = {
        "token": "abc",
        "password": "hunter2",
        "nested": {"password": "hunter2", "keep": [1, {"secret": "s"}]},
    }
    snapshot = copy.deepcopy(payload)

    redacted = redact_mapping(payload)

    assert payload == snapshot
    assert redacted is not payload
    assert redacted["nested"] is not payload["nested"]
    assert redacted["nested"]["keep"] is not payload["nested"]["keep"]
