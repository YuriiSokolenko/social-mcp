from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class SocialPlatform(StrEnum):
    THREADS = "threads"
    TIKTOK = "tiktok"


class ConnectedAccount(BaseModel):
    id: int | None = None
    platform: SocialPlatform
    external_account_id: str
    username: str | None = None
    scopes: list[str] = Field(default_factory=list)

    access_token_encrypted: bytes
    refresh_token_encrypted: bytes | None = None
    token_expires_at: datetime | None = None

    created_at: datetime
    updated_at: datetime
