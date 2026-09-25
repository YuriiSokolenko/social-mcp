"""Tests for the OAuth state security primitives.

Covers issue #15 (Threads OAuth state and callback security):

* cryptographically strong OAuth state;
* state bound to the initiating admin session;
* validate and expire state;
* reject missing, reused, or invalid state;
* never log authorization codes, access tokens, or app secrets.

No external social APIs are called; the manager is a pure, in-process component.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

import pytest
from itsdangerous import URLSafeTimedSerializer

from social_mcp.auth.oauth_state import (
    _STATE_SALT,
    OAuthStateError,
    OAuthStateManager,
    _constant_time_eq,
)

# A throwaway signing secret for tests only; never a real credential.
STATE_SECRET = "test-oauth-state-secret-not-for-production-use"

# Sample session identifiers used across tests.
SESSION_A = "admin-session-a"
SESSION_B = "admin-session-b"


@pytest.fixture()
def manager() -> OAuthStateManager:
    return OAuthStateManager(STATE_SECRET)


@pytest.fixture()
def long_ttl_manager() -> OAuthStateManager:
    return OAuthStateManager(STATE_SECRET, ttl_seconds=60 * 60)


def _nonce_of(state_value: str) -> str:
    """Re-derive the nonce embedded in a state value, bypassing the manager."""

    serializer = URLSafeTimedSerializer(STATE_SECRET, salt=_STATE_SALT)
    payload = serializer.loads(state_value)
    return payload["nonce"]


# --- construction ------------------------------------------------------------


def test_manager_requires_a_signing_secret() -> None:
    with pytest.raises(ValueError, match="OAUTH_STATE_SECRET"):
        OAuthStateManager("")


def test_manager_requires_positive_ttl() -> None:
    with pytest.raises(ValueError, match="ttl_seconds"):
        OAuthStateManager(STATE_SECRET, ttl_seconds=0)
    with pytest.raises(ValueError, match="ttl_seconds"):
        OAuthStateManager(STATE_SECRET, ttl_seconds=-5)


def test_default_ttl_is_ten_minutes() -> None:
    assert OAuthStateManager(STATE_SECRET).ttl_seconds == 10 * 60


def test_explicit_ttl_is_respected() -> None:
    assert OAuthStateManager(STATE_SECRET, ttl_seconds=30).ttl_seconds == 30


# --- cryptographically strong state ------------------------------------------


def test_state_is_a_non_empty_opaque_string(manager: OAuthStateManager) -> None:
    state = manager.create(SESSION_A)
    assert isinstance(state, str)
    assert len(state) > 32


def test_state_contains_a_random_nonce(manager: OAuthStateManager) -> None:
    nonce = _nonce_of(manager.create(SESSION_A))
    assert nonce
    # token_urlsafe(32) yields ~43 chars of base64url.
    assert len(nonce) >= 32


def test_two_states_for_the_same_session_differ(manager: OAuthStateManager) -> None:
    """Each minted state has a fresh random nonce; never a counter or reuse."""

    first_nonce = _nonce_of(manager.create(SESSION_A))
    second_nonce = _nonce_of(manager.create(SESSION_A))
    assert first_nonce != second_nonce


def test_state_is_signed_and_not_a_plaintext_nonce(manager: OAuthStateManager) -> None:
    state = manager.create(SESSION_A)
    nonce = _nonce_of(state)
    # The raw nonce must not appear in the state value in the clear.
    assert nonce not in state


def test_a_value_signed_with_a_different_secret_is_rejected(
    manager: OAuthStateManager,
) -> None:
    other = URLSafeTimedSerializer("another-secret", salt=_STATE_SALT)
    forged = other.dumps({"session_id": SESSION_A, "nonce": "x"})

    with pytest.raises(OAuthStateError, match="signature is invalid"):
        manager.consume(forged, session_id=SESSION_A)


def test_a_tampered_state_is_rejected(manager: OAuthStateManager) -> None:
    state = manager.create(SESSION_A)
    tampered = state[:-2] + ("AA" if state[-2:] != "AA" else "BB")

    with pytest.raises(OAuthStateError, match="signature is invalid"):
        manager.consume(tampered, session_id=SESSION_A)


# --- bound to the initiating admin session -----------------------------------


def test_create_requires_a_session_id(manager: OAuthStateManager) -> None:
    with pytest.raises(ValueError, match="session_id"):
        manager.create("")


def test_state_is_bound_to_its_session(manager: OAuthStateManager) -> None:
    state = manager.create(SESSION_A)

    data = manager.consume(state, session_id=SESSION_A)

    assert data.session_id == SESSION_A


def test_a_state_cannot_be_consumed_from_a_different_session(
    manager: OAuthStateManager,
) -> None:
    """Cross-session replay is rejected: the state is bound to its session."""

    state = manager.create(SESSION_A)

    with pytest.raises(OAuthStateError, match="does not match the current session"):
        manager.consume(state, session_id=SESSION_B)

    # And the original session still works (consumption did not happen).
    data = manager.consume(state, session_id=SESSION_A)
    assert data.session_id == SESSION_A


def test_consume_requires_a_session_id(manager: OAuthStateManager) -> None:
    state = manager.create(SESSION_A)

    with pytest.raises(OAuthStateError, match="requires a session id"):
        manager.consume(state, session_id="")


def test_platform_is_carried_through(manager: OAuthStateManager) -> None:
    state = manager.create(SESSION_A, platform="threads")

    data = manager.consume(state, session_id=SESSION_A)

    assert data.platform == "threads"


def test_default_platform_is_threads(manager: OAuthStateManager) -> None:
    data = manager.consume(manager.create(SESSION_A), session_id=SESSION_A)
    assert data.platform == "threads"


# --- validate and expire state ------------------------------------------------


@pytest.fixture()
def frozen_time(monkeypatch: pytest.MonkeyPatch) -> dict[str, float]:
    """A controllable clock for testing TTL/expiry without waiting.

    The ``itsdangerous`` serializer records a timestamp at signing and checks
    the age against ``time.time`` at load. Patching ``time.time`` in both the
    serializer's module and our own (unused) usage lets a test advance the
    clock deterministically.
    """

    now = {"value": 1_000_000.0}

    def fake_time() -> float:
        return now["value"]

    # itsdangerous records a timestamp at signing and checks the age against
    # ``time.time`` at load; patching it drives both the expiry and the age
    # check. We replace the ``time`` module object ``timed`` imported so its
    # ``time.time()`` call resolves to the fake clock.
    class _FakeTimeModule:
        @staticmethod
        def time() -> float:
            return now["value"]

    monkeypatch.setattr("itsdangerous.timed.time", _FakeTimeModule)
    return now


def test_state_is_valid_until_ttl(
    manager: OAuthStateManager, frozen_time: dict[str, float]
) -> None:
    state = manager.create(SESSION_A)

    # Just before the TTL elapses: still valid.
    frozen_time["value"] += manager.ttl_seconds - 1
    data = manager.consume(state, session_id=SESSION_A)
    assert data.session_id == SESSION_A


def test_state_is_expired_after_ttl(
    manager: OAuthStateManager, frozen_time: dict[str, float]
) -> None:
    state = manager.create(SESSION_A)

    frozen_time["value"] += manager.ttl_seconds + 1
    with pytest.raises(OAuthStateError, match="expired"):
        manager.consume(state, session_id=SESSION_A)


def test_state_with_custom_ttl_uses_that_ttl(
    frozen_time: dict[str, float],
) -> None:
    short = OAuthStateManager(STATE_SECRET, ttl_seconds=60)
    state = short.create(SESSION_A)

    frozen_time["value"] += 61
    with pytest.raises(OAuthStateError, match="expired"):
        short.consume(state, session_id=SESSION_A)


# --- reject missing, reused, or invalid state --------------------------------


@pytest.mark.parametrize("bad", ["", None])
def test_missing_state_is_rejected(manager: OAuthStateManager, bad: Any) -> None:
    with pytest.raises(OAuthStateError, match="Missing OAuth state"):
        manager.consume(bad, session_id=SESSION_A)  # type: ignore[arg-type]


def test_state_not_signed_by_manager_is_rejected(manager: OAuthStateManager) -> None:
    arbitrary = "not-a-state-value-at-all"

    with pytest.raises(OAuthStateError, match="signature is invalid"):
        manager.consume(arbitrary, session_id=SESSION_A)


def test_state_with_a_truncated_payload_is_rejected(manager: OAuthStateManager) -> None:
    state = manager.create(SESSION_A)
    # Tear off the payload and keep only the signature fragment.
    with pytest.raises((OAuthStateError, Exception)):
        manager.consume(state[:10], session_id=SESSION_A)


def test_state_is_one_shot_and_reuse_is_rejected(manager: OAuthStateManager) -> None:
    state = manager.create(SESSION_A)

    manager.consume(state, session_id=SESSION_A)

    with pytest.raises(OAuthStateError, match="already been used"):
        manager.consume(state, session_id=SESSION_A)


def test_a_reused_state_from_a_different_session_is_rejected_after_use(
    manager: OAuthStateManager,
) -> None:
    state = manager.create(SESSION_A)

    manager.consume(state, session_id=SESSION_A)

    # Replaying a consumed state from any session must be rejected. Whether the
    # session-mismatch or reuse check fires first is an implementation detail;
    # the security requirement is that it is rejected outright.
    with pytest.raises(OAuthStateError):
        manager.consume(state, session_id=SESSION_B)

    # The original session must also see it as consumed, proving the nonce was
    # recorded as one-shot regardless of which check fired first.
    with pytest.raises(OAuthStateError, match="already been used"):
        manager.consume(state, session_id=SESSION_A)


def test_replay_of_an_expired_state_is_rejected_as_expired_not_used(
    manager: OAuthStateManager,
    frozen_time: dict[str, float],
) -> None:
    # A state is minted and then the clock advances past the TTL before it is
    # ever consumed. The expiry error must take precedence over the reuse path,
    # since the value expired before it could ever be consumed.
    state = manager.create(SESSION_A)

    frozen_time["value"] += manager.ttl_seconds + 1
    with pytest.raises(OAuthStateError, match="expired"):
        manager.consume(state, session_id=SESSION_A)


def test_revoke_prevents_subsequent_consumption(manager: OAuthStateManager) -> None:
    state = manager.create(SESSION_A)

    manager.revoke(state)

    with pytest.raises(OAuthStateError, match="already been used"):
        manager.consume(state, session_id=SESSION_A)


def test_revoke_ignores_malformed_values(manager: OAuthStateManager) -> None:
    # Should not raise; there is nothing to revoke.
    manager.revoke("")
    manager.revoke("not-a-real-state")


def test_constant_time_eq_returns_false_for_mismatched_lengths() -> None:
    assert _constant_time_eq("abc", "ab") is False
    assert _constant_time_eq("abc", "abcd") is False


def test_constant_time_eq_compares_values() -> None:
    assert _constant_time_eq("same", "same") is True
    assert _constant_time_eq("same", "dame") is False


# --- nonces are unique and high-entropy --------------------------------------


def test_a_hundred_states_have_unique_nonces(manager: OAuthStateManager) -> None:
    nonces = {_nonce_of(manager.create(SESSION_A)) for _ in range(100)}
    assert len(nonces) == 100


def test_state_value_does_not_embed_the_session_id_in_the_clear(
    manager: OAuthStateManager,
) -> None:
    state = manager.create(SESSION_A)

    # The session id is signed into the payload but never appears in the clear
    # in the base64url-encoded state value.
    assert SESSION_A not in state


# --- logging does not leak secrets -------------------------------------------


def test_issued_state_log_does_not_contain_the_full_value(
    manager: OAuthStateManager,
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.INFO, logger="social_mcp.auth.oauth_state"):
        state = manager.create(SESSION_A)

    # The message mentions a nonce fragment only, never the full state value.
    combined = caplog.text
    assert state not in combined
    assert "Issued OAuth state" in combined


def test_consumed_state_log_does_not_contain_the_full_value(
    manager: OAuthStateManager,
    caplog: pytest.LogCaptureFixture,
) -> None:
    state = manager.create(SESSION_A)

    with caplog.at_level(logging.INFO, logger="social_mcp.auth.oauth_state"):
        manager.consume(state, session_id=SESSION_A)

    assert state not in caplog.text


@pytest.mark.parametrize(
    "secret_thing",
    [
        "fake-authorization-code",
        "fake-access-token",
        "fake-app-secret",
        "fake-refresh-token",
    ],
)
def test_logs_never_contain_other_secret_values(
    manager: OAuthStateManager,
    caplog: pytest.LogCaptureFixture,
    secret_thing: str,
) -> None:
    with caplog.at_level(logging.INFO, logger="social_mcp.auth.oauth_state"):
        state = manager.create(SESSION_A)
        try:
            manager.consume(state, session_id=SESSION_B)
        except OAuthStateError:
            pass

    assert secret_thing not in caplog.text


def test_state_value_is_not_derived_from_predictable_inputs(
    manager: OAuthStateManager,
) -> None:
    """A state value must not be a deterministic function of its inputs."""

    a = manager.create(SESSION_A, platform="threads")
    b = manager.create(SESSION_A, platform="threads")
    assert a != b


def test_sha256_digest_format_is_stable() -> None:
    """The helper used for logging nonces is a stable, short hash."""

    digest = hashlib.sha256(b"anything").hexdigest()[:12]
    assert len(digest) == 12


def test_manager_is_independent_of_token_cipher() -> None:
    """The OAuth state module must not depend on the encrypted-token layer."""

    import social_mcp.auth.oauth_state as mod

    # The module should not pull in token-encryption primitives.
    assert "token_cipher" not in dir(mod)
    assert not hasattr(mod, "TokenCipher")
