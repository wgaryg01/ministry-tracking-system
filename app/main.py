from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import create_engine, text
import traceback

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
from app.meetings import router as meetings_router
from app.feedback import router as feedback_router
from app.check_register import router as check_register_router
from app.scheduler import start_scheduler
from app.log_buffer import install_log_capture, get_recent_log_lines
from app.github_issues import create_github_issue, GitHubIssueError

install_log_capture()

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
app.include_router(meetings_router)
app.include_router(feedback_router)
app.include_router(check_register_router)

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


@app.exception_handler(Exception)
async def auto_file_issue_on_500(request: Request, exc: Exception):
    """
    Any unhandled exception both files a GitHub issue (if configured)
    with the traceback and the last 50 lines of server output, and
    still returns a normal 500 to the client — this never changes
    what the user sees, it just also reports it automatically.
    """
    tb = traceback.format_exc()
    log_tail = "\n".join(get_recent_log_lines())
    env_tag = "[Development] " if settings.environment == "development" else ""
    title = f"{env_tag}Unhandled error: {type(exc).__name__} on {request.method} {request.url.path}"
    body = (
        f"**Environment:** {settings.environment}\n"
        f"**Request:** {request.method} {request.url.path}\n\n"
        f"### Traceback\n```\n{tb}\n```\n\n"
        f"### Last 50 log lines\n```\n{log_tail}\n```"
    )
    if settings.github_configured:
        try:
            create_github_issue(title, body, labels=["auto-reported", "bug"])
        except GitHubIssueError as e:
            print(f"WARNING: failed to auto-file issue for unhandled error: {e}")

    return JSONResponse(status_code=500, content={"detail": "Internal server error"})
