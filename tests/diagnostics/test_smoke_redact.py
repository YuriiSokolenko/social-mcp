"""Focused coverage for the smoke redaction helper."""

from social_mcp.diagnostics.smoke_redact import DEFAULT_REDACTION, redact_mapping

SENSITIVE = ("token", "api_key", "password")


def test_redact_mapping_redacts_top_level_sensitive_key() -> None:
    payload = {"token": "abc123", "other": "visible"}

    result = redact_mapping(payload, SENSITIVE)

    assert result == {"token": "***", "other": "visible"}
    assert result["token"] == DEFAULT_REDACTION


def test_redact_mapping_recurses_through_nested_dictionaries() -> None:
    payload = {
        "request": {
            "headers": {"authorization": "Bearer xyz", "accept": "json"},
            "body": {"api_key": "secret-value"},
        },
        "status": 200,
    }

    result = redact_mapping(payload, (*SENSITIVE, "authorization"))

    assert result == {
        "request": {
            "headers": {"authorization": "***", "accept": "json"},
            "body": {"api_key": "***"},
        },
        "status": 200,
    }


def test_redact_mapping_recurses_through_nested_lists() -> None:
    payload = {
        "events": [
            {"token": "one"},
            {"token": "two", "name": "keep"},
            ["plain", {"password": "pw"}],
        ],
    }

    result = redact_mapping(payload, SENSITIVE)

    assert result == {
        "events": [
            {"token": "***"},
            {"token": "***", "name": "keep"},
            ["plain", {"password": "***"}],
        ],
    }


def test_redact_mapping_handles_multiple_sensitive_keys_in_one_mapping() -> None:
    payload = {"token": "a", "api_key": "b", "password": "c", "safe": "d"}

    result = redact_mapping(payload, SENSITIVE)

    assert result == {"token": "***", "api_key": "***", "password": "***", "safe": "d"}


def test_redact_mapping_matches_keys_case_insensitively() -> None:
    payload = {"Token": "a", "API_KEY": "b", "PaSsWoRd": "c"}

    result = redact_mapping(payload, SENSITIVE)

    assert result == {"Token": "***", "API_KEY": "***", "PaSsWoRd": "***"}


def test_redact_mapping_matches_only_exact_key_names() -> None:
    payload = {"tokens": "a", "tokenised": "b", "api_key_value": "c", "token": "d"}

    result = redact_mapping(payload, SENSITIVE)

    assert result == {
        "tokens": "a",
        "tokenised": "b",
        "api_key_value": "c",
        "token": "***",
    }


def test_redact_mapping_accepts_any_iterable_of_sensitive_keys() -> None:
    payload = {"token": "a"}

    assert redact_mapping(payload, ["token"]) == {"token": "***"}
    assert redact_mapping(payload, {"token"}) == {"token": "***"}


def test_redact_mapping_supports_custom_replacement() -> None:
    payload = {"nested": {"token": "a"}, "items": [{"token": "b"}]}

    result = redact_mapping(payload, SENSITIVE, replacement="[redacted]")

    assert result == {
        "nested": {"token": "[redacted]"},
        "items": [{"token": "[redacted]"}],
    }


def test_redact_mapping_leaves_non_matching_scalars_unchanged() -> None:
    payload = {"count": 3, "ratio": 1.5, "enabled": True, "none": None, "text": "keep"}

    assert redact_mapping(payload, SENSITIVE) == payload


def test_redact_mapping_does_not_mutate_input() -> None:
    payload = {
        "token": "a",
        "nested": {"password": "b", "list": [{"token": "c"}]},
    }
    snapshot = {
        "token": "a",
        "nested": {"password": "b", "list": [{"token": "c"}]},
    }

    result = redact_mapping(payload, SENSITIVE)

    assert payload == snapshot
    assert payload["nested"]["list"][0]["token"] == "c"
    assert result is not payload
    assert result["nested"] is not payload["nested"]
    assert result["nested"]["list"] is not payload["nested"]["list"]


def test_redact_mapping_without_sensitive_keys_returns_equal_copy() -> None:
    payload = {"a": {"b": [1, {"c": "d"}]}}

    result = redact_mapping(payload, ())

    assert result == payload
    assert result is not payload
    assert result["a"] is not payload["a"]


def test_redact_mapping_recurses_through_tuple_containers() -> None:
    payload = {"pair": ("token", {"token": "secret"}), "token": "a"}

    result = redact_mapping(payload, SENSITIVE)

    assert result == {"pair": ("token", {"token": "***"}), "token": "***"}
    assert isinstance(result["pair"], tuple)
