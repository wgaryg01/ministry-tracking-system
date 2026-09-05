from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy import create_engine, text

from app.config import settings
from app.auth import router as auth_router
from app.elevation import router as elevation_router
from app.identities import router as identities_router
from app.activities import router as activities_router
from app.users import router as users_router
from app.org_settings import router as org_settings_router
from app.people import router as people_router
from app.requests import router as requests_router
from app.reports import router as reports_router
from app.scheduler import start_scheduler

app = FastAPI(title="Ministry Client Tracking System")
app.include_router(auth_router)
app.include_router(elevation_router)
app.include_router(identities_router)
app.include_router(activities_router)
app.include_router(users_router)
app.include_router(org_settings_router)
app.include_router(people_router)
app.include_router(requests_router)
app.include_router(reports_router)

app.mount("/static", StaticFiles(directory="frontend"), name="static")


@app.middleware("http")
async def no_cache_static(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
def serve_index():
    return FileResponse("frontend/index.html")


@app.get("/verify")
def serve_verify():
    # Same SPA shell — app.js checks the path and handles the token client-side.
    return FileResponse("frontend/index.html")


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
