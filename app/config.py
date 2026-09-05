from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    db_user: str
    db_password: str
    db_name: str
    db_host: str = "db"
    db_port: int = 5432

    # Symmetric key for encrypting PII fields at the application layer,
    # in addition to the DB connection being SSL-encrypted in transit.
    # Generate with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    pii_encryption_key: str

    # Used to sign magic-link tokens
    secret_key: str

    smtp_host: str
    smtp_port: int = 587
    smtp_username: str
    smtp_password: str
    smtp_from: str

    # Base URL used to build the link inside magic-link emails
    app_base_url: str = "http://localhost:8000"

    # Optional — SMS notifications are skipped entirely if any of these
    # are unset. Not required for the app to run.
    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_phone_number: str | None = None

    # Shows "(Development)" next to the site name in the browser tab
    # and header, regardless of who's logged in or what the ministry
    # name is set to. Set ENVIRONMENT=production (or leave unset) on
    # the real server.
    environment: str = "production"

    class Config:
        env_file = ".env"

    @property
    def twilio_configured(self) -> bool:
        return bool(self.twilio_account_sid and self.twilio_auth_token and self.twilio_phone_number)

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+psycopg2://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}?sslmode=require"
        )


settings = Settings()
