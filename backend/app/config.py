from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    app_env: str = "demo"
    provider: str = "free"
    market_provider: str = Field(default="free", validation_alias="MARKET_PROVIDER")
    news_provider: str = Field(default="gdelt", validation_alias="NEWS_PROVIDER")
    database_url: str = "postgresql://qijian:qijian@postgres:5432/qijian"
    redis_url: str = "redis://redis:6379/0"
    market_data_api_key: str = ""
    alpha_vantage_api_key: str = Field(default="", validation_alias="ALPHAVANTAGE_API_KEY")
    fred_api_key: str = Field(default="", validation_alias="FRED_API_KEY")
    cftc_app_token: str = Field(default="", validation_alias="CFTC_APP_TOKEN")
    global_events_url: str = Field(default="", validation_alias="GLOBAL_EVENTS_URL")
    events_fetch_timeout_ms: int = Field(default=8000, validation_alias="EVENTS_FETCH_TIMEOUT_MS")
    http_timeout_seconds: float = 8.0
    vision_provider: str = Field(default="openai", validation_alias="VISION_PROVIDER")
    vision_api_key: str = Field(default="", validation_alias="VISION_API_KEY")
    openai_api_key: str = Field(default="", validation_alias="OPENAI_API_KEY")
    openai_vision_model: str = Field(default="gpt-4o", validation_alias="OPENAI_VISION_MODEL")
    vision_timeout_seconds: float = Field(default=25.0, validation_alias="VISION_TIMEOUT_SECONDS")
    news_api_key: str = ""
    allowed_origins: str = "http://localhost:3000"
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

settings = Settings()
