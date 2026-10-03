"""Tests for the recursive sensitive-key masking smoke helper."""

from __future__ import annotations

import copy

from social_mcp.diagnostics.smoke_mask_keys import mask_mapping


def test_masks_top_level_keys_only() -> None:
    masked = mask_mapping({"token": "abc", "name": "service"})

    assert masked == {"token": "<redacted>", "name": "service"}


def test_recurses_through_nested_structures() -> None:
    payload = {
        "request": {
            "headers": {"authorization": "Bearer abc", "accept": "application/json"},
            "body": {"items": [{"password": "hunter2"}, {"id": 7}]},
        },
        "status": 200,
    }

    assert mask_mapping(payload) == {
        "request": {
            "headers": {"authorization": "<redacted>", "accept": "application/json"},
            "body": {"items": [{"password": "<redacted>"}, {"id": 7}]},
        },
        "status": 200,
    }


def test_masks_repeated_keys_at_every_depth() -> None:
    payload = {
        "token": "one",
        "nested": {"token": "two", "deeper": [{"token": "three"}]},
    }

    assert mask_mapping(payload) == {
        "token": "<redacted>",
        "nested": {"token": "<redacted>", "deeper": [{"token": "<redacted>"}]},
    }


def test_matches_keys_case_insensitively() -> None:
    masked = mask_mapping({"Token": "one", "TOKEN": "two", "AUTHORIZATION": "three"})

    assert masked == {
        "Token": "<redacted>",
        "TOKEN": "<redacted>",
        "AUTHORIZATION": "<redacted>",
    }


def test_key_must_match_exactly_beyond_case() -> None:
    assert mask_mapping({"tokenized": "keep", "cookies": "keep"}) == {
        "tokenized": "keep",
        "cookies": "keep",
    }


def test_custom_replacement() -> None:
    masked = mask_mapping({"secret": "s3cret"}, replacement="[hidden]")

    assert masked == {"secret": "[hidden]"}


def test_custom_sensitive_keys() -> None:
    payload = {"internal": "value", "token": "abc"}

    assert mask_mapping(payload, sensitive_keys={"internal"}) == {
        "internal": "<redacted>",
        "token": "abc",
    }


def test_leaves_non_matching_scalars_unchanged() -> None:
    payload = {"count": 3, "ratio": 0.5, "enabled": True, "note": None}

    assert mask_mapping(payload) == payload


def test_does_not_mutate_input() -> None:
    payload = {
        "token": "abc",
        "nested": {"secret": "xyz", "items": [{"password": "hunter2"}]},
    }
    original = copy.deepcopy(payload)

    mask_mapping(payload)

    assert payload == original


def test_does_not_share_containers_with_input() -> None:
    payload = {"nested": {"keep": "value"}}

    masked = mask_mapping(payload)
    masked["nested"]["keep"] = "changed"

    assert payload["nested"]["keep"] == "value"
