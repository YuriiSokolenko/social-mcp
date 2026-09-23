import pytest
from cryptography.fernet import Fernet

from social_mcp.auth.token_cipher import TokenCipher


def test_encrypt_then_decrypt_returns_original_token() -> None:
    cipher = TokenCipher(Fernet.generate_key().decode("utf-8"))
    token = "threads-access-token"

    encrypted = cipher.encrypt(token)

    assert encrypted != token.encode("utf-8")
    assert cipher.decrypt(encrypted) == token


def test_decrypt_with_different_key_fails() -> None:
    cipher = TokenCipher(Fernet.generate_key().decode("utf-8"))
    other_cipher = TokenCipher(Fernet.generate_key().decode("utf-8"))
    encrypted = cipher.encrypt("threads-access-token")

    with pytest.raises(
        ValueError,
        match="Unable to decrypt token with the configured encryption key",
    ):
        other_cipher.decrypt(encrypted)
