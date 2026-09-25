"""OAuth state security primitives for Threads (and future platform) OAuth.

This module implements the state-validation boundary that protects the OAuth
authorization-code flow *before* the Meta token exchange (see issue #15, which
precedes issue #2). It is intentionally independent of any network or token
exchange: it only mints, binds, signs, validates, expires and consumes opaque,
unpredictable state values.

Security model
--------------

1. **Cryptographically strong state.** Each state is a 256-bit random value
   (``secrets.token_urlsafe(32)``) signed with HMAC via
   :class:`itsdangerous.URLSafeTimedSerializer`. The random component is
   unguessable; the signature bounds it to this service's ``OAUTH_STATE_SECRET``
   so a forged value cannot be accepted.

2. **Bound to the initiating admin session.** A caller-supplied
   ``session_id`` is embedded in the signed payload. ``consume`` requires the
   same ``session_id`` that was used for ``create``, so a state minted during
   one admin session cannot be redeemed from another (defeating a cross-session
   CSRF / login-CSRF).

3. **Validated and expired.** The signed value carries a creation timestamp.
   ``consume`` rejects values older than ``ttl_seconds`` and values whose
   signature is malformed.

4. **One-shot: rejects reuse.** Once consumed (or explicitly revoked), a state
   cannot be consumed again. The in-memory store tracks consumed nonces.

5. **Rejects missing / invalid / reused state.** ``consume`` raises
   :class:`OAuthStateError` with a safe, non-secret message for every failure
   mode.

Logging policy
--------------

Only the *nonce* of a state value (a short hash) is ever logged, never the
full state, the authorization code, the access token, the app secret, or the
encryption key. Messages must remain safe at INFO level.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from dataclasses import dataclass
from typing import TypedDict

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

logger = logging.getLogger(__name__)

#: Default lifetime of an OAuth state, in seconds (10 minutes). Short enough to
#: limit the interception window, long enough for a real browser round-trip.
DEFAULT_STATE_TTL_SECONDS = 10 * 60

#: Salt namespacing the signed state so a state value cannot be confused with
#: other signed objects (e.g. session cookies) sharing the same secret.
_STATE_SALT = "social-mcp-oauth-state"

#: Minimum entropy, in bytes, of the random state component.
_STATE_RANDOM_BYTES = 32


class OAuthStateError(ValueError):
    """A state-validation failure with a safe, client-facing message.

    Raised by :meth:`OAuthStateManager.consume` for any rejected state. The
    message describes the failure category and never contains a secret value.
    """


@dataclass(frozen=True)
class OAuthStateData:
    """The payload embedded in a signed state value."""

    #: Opaque identifier of the initiating admin session/request.
    session_id: str
    #: The random, unguessable nonce embedded in the state.
    nonce: str
    #: The platform the state is intended for (e.g. ``"threads"``).
    platform: str


class _StatePayload(TypedDict):
    """On-the-wire payload serialized into the signed state value."""

    session_id: str
    nonce: str
    platform: str


def _state_nonce(state_value: str) -> str:
    """Return a short, non-reversible digest of a state value for logging.

    Only this digest is ever logged, never the full state value, the
    authorization code, tokens, or app secrets.
    """

    return hashlib.sha256(state_value.encode("utf-8")).hexdigest()[:12]


class OAuthStateManager:
    """Mint, sign, validate, expire and consume OAuth state values.

    The state is bound to the caller's admin ``session_id`` and signed with a
    deployment-provided ``OAUTH_STATE_SECRET``. The manager tracks consumed
    nonces so a state can only be redeemed once.

    This class is not thread-safe; it is intended to live for the lifetime of
    the application container. Platform adapters call :meth:`create` when
    building an authorization URL and :meth:`consume` from the OAuth callback
    before exchanging the code for tokens.
    """

    def __init__(
        self,
        state_secret: str,
        *,
        ttl_seconds: int = DEFAULT_STATE_TTL_SECONDS,
    ) -> None:
        """Bind the manager to a signing secret and lifetime.

        Args:
            state_secret: A long, random, deployment-provided secret that signs
                state values. It must never be committed to Git and is never
                logged. A malformed or empty value prevents the manager from
                issuing or accepting state (fail closed).
            ttl_seconds: How long a minted state remains valid, in seconds.

        Raises:
            ValueError: If ``state_secret`` is empty or ``ttl_seconds`` is not
                positive.
        """

        if not state_secret:
            raise ValueError("OAUTH_STATE_SECRET must be configured for OAuth state.")
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive.")
        self._serializer = URLSafeTimedSerializer(state_secret, salt=_STATE_SALT)
        self._ttl_seconds = ttl_seconds
        # Nonces consumed by a successful ``consume``. Membership prevents reuse.
        self._consumed: set[str] = set()

    @property
    def ttl_seconds(self) -> int:
        """The lifetime, in seconds, a minted state remains valid for."""

        return self._ttl_seconds

    def create(
        self,
        session_id: str,
        *,
        platform: str = "threads",
    ) -> str:
        """Mint a fresh, signed, session-bound state value.

        Args:
            session_id: An identifier for the initiating admin session/request.
                It must be stable for the lifetime of the authorization round
                trip (e.g. the signed session cookie id) and unique across
                sessions.
            platform: The OAuth platform the state is intended for.

        Returns:
            An opaque, signed state string safe to place in an authorization
            URL. Its random component is cryptographically strong and its
            signature binds it to ``session_id`` and ``platform``.

        Raises:
            ValueError: If ``session_id`` is empty.
        """

        if not session_id:
            raise ValueError("session_id is required to mint OAuth state.")
        nonce = secrets.token_urlsafe(_STATE_RANDOM_BYTES)
        payload: _StatePayload = {
            "session_id": session_id,
            "nonce": nonce,
            "platform": platform,
        }
        state_value = self._serializer.dumps(payload)
        logger.info("Issued OAuth state for platform=%s nonce=%s", platform, nonce[:8])
        return state_value

    def _decode(self, state_value: str, *, max_age: int) -> OAuthStateData:
        """Verify signature and expiry of a state value.

        Args:
            state_value: The signed state string from the callback.
            max_age: The maximum age, in seconds, for the value to be accepted.

        Returns:
            The decoded :class:`OAuthStateData`.

        Raises:
            OAuthStateError: If the value is malformed, has a bad signature,
                or has expired.
        """

        if not state_value:
            raise OAuthStateError("Missing OAuth state parameter.")
        try:
            payload = self._serializer.loads(state_value, max_age=max_age)
        except SignatureExpired as exc:
            raise OAuthStateError("OAuth state has expired.") from exc
        except BadSignature as exc:
            raise OAuthStateError("OAuth state signature is invalid.") from exc

        if not isinstance(payload, dict):
            raise OAuthStateError("OAuth state payload is malformed.")

        session_id = payload.get("session_id")
        nonce = payload.get("nonce")
        platform = payload.get("platform")
        if not (isinstance(session_id, str) and session_id and isinstance(nonce, str) and nonce):
            raise OAuthStateError("OAuth state payload is incomplete.")
        # ``platform`` is expected but optional in the signed payload for
        # forward compatibility; default to "threads" when absent.
        if not isinstance(platform, str) or not platform:
            platform = "threads"

        return OAuthStateData(
            session_id=session_id,
            nonce=nonce,
            platform=platform,
        )

    def consume(self, state_value: str, *, session_id: str) -> OAuthStateData:
        """Validate and consume a state value from an OAuth callback.

        The state is verified for signature, expiry, session binding, and
        one-shot use. On success it is marked consumed and cannot be used again.

        Args:
            state_value: The state string returned by the OAuth provider
                (matching what :meth:`create` placed in the authorization URL).
            session_id: The identifier of the admin session making the callback.
                It must match the ``session_id`` used at creation.

        Returns:
            The :class:`OAuthStateData` bound to the state.

        Raises:
            OAuthStateError: If the state is missing, malformed, expired,
                signatures don't verify, the session id does not match, or the
                state has already been used.
        """

        data = self._decode(state_value, max_age=self._ttl_seconds)

        if not session_id:
            raise OAuthStateError("OAuth state callback requires a session id.")
        # Constant-time comparison to avoid leaking session-id mismatches via
        # timing. ``compare_digest`` requires both sides to be the same type.
        session_ok = _constant_time_eq(data.session_id, session_id)
        if not session_ok:
            logger.warning(
                "OAuth state session mismatch (nonce=%s).", data.nonce[:8]
            )
            raise OAuthStateError("OAuth state does not match the current session.")

        if data.nonce in self._consumed:
            logger.warning(
                "Rejected reuse of already-consumed OAuth state (nonce=%s).",
                data.nonce[:8],
            )
            raise OAuthStateError("OAuth state has already been used.")

        self._consumed.add(data.nonce)
        logger.info(
            "Consumed OAuth state for platform=%s nonce=%s", data.platform, data.nonce[:8]
        )
        return data

    def revoke(self, state_value: str) -> None:
        """Mark a state's nonce as consumed without validating its binding.

        Used when a callback is abandoned partway through (e.g. user cancels at
        the provider) so a later replay of the same value is rejected. Malformed
        values are silently ignored, since there is nothing to revoke.

        Args:
            state_value: The state string to invalidate.
        """

        if not state_value:
            return
        try:
            data = self._decode(state_value, max_age=self._ttl_seconds)
        except OAuthStateError:
            # Nothing verifiable to revoke; the value would already fail
            # ``consume`` for the same reason.
            return
        self._consumed.add(data.nonce)
        logger.info(
            "Revoked OAuth state for platform=%s nonce=%s",
            data.platform,
            data.nonce[:8],
        )


def _constant_time_eq(a: str, b: str) -> bool:
    """Compare two strings in constant time, tolerating differing lengths."""

    if len(a) != len(b):
        return False
    result = 0
    for x, y in zip(a.encode("utf-8"), b.encode("utf-8")):
        result |= x ^ y
    return result == 0
