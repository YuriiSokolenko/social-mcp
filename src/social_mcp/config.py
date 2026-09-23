from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Social MCP"
    environment: str = "development"

    database_url: str = "sqlite:///./data/social-mcp.db"

    meta_app_id: str | None = None
    meta_app_secret: str | None = None
    tiktok_client_key: str | None = None
    tiktok_client_secret: str | None = None

    token_encryption_key: str | None = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
