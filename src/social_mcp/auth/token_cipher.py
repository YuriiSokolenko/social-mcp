from cryptography.fernet import Fernet, InvalidToken


class TokenCipher:
    def __init__(self, key: str) -> None:
        if not key:
            raise ValueError("TOKEN_ENCRYPTION_KEY is required.")
        try:
            self._fernet = Fernet(key.encode("utf-8"))
        except (TypeError, ValueError) as exc:
            raise ValueError(
                "TOKEN_ENCRYPTION_KEY must be a valid Fernet key."
            ) from exc

    def encrypt(self, token: str) -> bytes:
        if not token:
            raise ValueError("Token must not be empty.")
        return self._fernet.encrypt(token.encode("utf-8"))

    def decrypt(self, encrypted_token: bytes) -> str:
        try:
            return self._fernet.decrypt(encrypted_token).decode("utf-8")
        except InvalidToken as exc:
            raise ValueError(
                "Unable to decrypt token with the configured encryption key."
            ) from exc
