from fastapi import FastAPI
from sqlalchemy import create_engine, text

from app.config import settings

app = FastAPI(title="Ministry Client Tracking System")


@app.get("/health")
def health():
    """Basic liveness check plus a DB round-trip to confirm SSL connection works."""
    engine = create_engine(settings.database_url)
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    return {"status": "ok"}
