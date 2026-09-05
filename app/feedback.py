from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User
from app.auth import get_current_user
from app.github_issues import create_github_issue, GitHubIssueError
from app.config import settings
from app.audit import log_audit_event

router = APIRouter(prefix="/feedback", tags=["feedback"])


class FeedbackCreate(BaseModel):
    title: str
    description: str
    page_context: str | None = None  # e.g. which page/screen they were on, sent by the frontend


@router.post("")
def submit_feedback(
    payload: FeedbackCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Files a GitHub issue on the user's behalf — they never need a
    GitHub account. Available to every role, since anyone might spot
    a bug or want to suggest something.
    """
    env_tag = "[Development] " if settings.environment == "development" else ""
    body = (
        f"**Reported by:** {current_user.full_name or current_user.email or current_user.username} "
        f"({current_user.role.value})\n"
        f"**Environment:** {settings.environment}\n"
        f"**Page:** {payload.page_context or 'not specified'}\n\n"
        f"---\n\n{payload.description}"
    )

    try:
        issue = create_github_issue(f"{env_tag}{payload.title}", body, labels=["user-reported"])
    except GitHubIssueError as e:
        raise HTTPException(status_code=502, detail=f"Couldn't file the issue: {e}")

    log_audit_event(
        db, current_user.id, "feedback_issue_created",
        resource_type="github_issue", details=f"url={issue.get('html_url')}",
    )

    return {"message": "Issue created", "url": issue.get("html_url")}
