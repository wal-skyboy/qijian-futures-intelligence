from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    app_env: str = "demo"
    provider: str = "demo"
    database_url: str = "postgresql://qijian:qijian@postgres:5432/qijian"
    redis_url: str = "redis://redis:6379/0"
    market_data_api_key: str = ""
    news_api_key: str = ""
    allowed_origins: str = "http://localhost:3000"
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

settings = Settings()
