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

    class Config:
        env_file = ".env"

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+psycopg2://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}?sslmode=require"
        )


settings = Settings()
