from fastapi import FastAPI
from sqlalchemy import create_engine, text

from app.config import settings
from app.auth import router as auth_router
from app.elevation import router as elevation_router
from app.identities import router as identities_router
from app.activities import router as activities_router
from app.users import router as users_router
from app.scheduler import start_scheduler

app = FastAPI(title="Ministry Client Tracking System")
app.include_router(auth_router)
app.include_router(elevation_router)
app.include_router(identities_router)
app.include_router(activities_router)
app.include_router(users_router)

_scheduler = None


@app.on_event("startup")
def _launch_scheduler():
    global _scheduler
    _scheduler = start_scheduler()


@app.get("/health")
def health():
    """Basic liveness check plus a DB round-trip to confirm SSL connection works."""
    engine = create_engine(settings.database_url)
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    return {"status": "ok"}
