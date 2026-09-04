import hashlib
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response, Cookie
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, MagicLinkToken
from app.email import send_magic_link_email, send_invitation_email
from app.session import create_session_token, read_session_token, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS
from app.config import settings
from app.audit import log_audit_event

router = APIRouter(prefix="/auth", tags=["auth"])

TOKEN_TTL_MINUTES = 15


class MagicLinkRequest(BaseModel):
    email: EmailStr


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode()).hexdigest()


def issue_magic_link(db: Session, user: User, invitation: bool = False) -> None:
    """
    Shared by regular sign-in requests and admin-issued invitations —
    both create a single-use, 15-minute token and email a link built
    from it. `invitation` only changes which email template is used.
    """
    raw_token = secrets.token_urlsafe(32)
    token_row = MagicLinkToken(
        user_id=user.id,
        token_hash=_hash_token(raw_token),
        expires_at=datetime.utcnow() + timedelta(minutes=TOKEN_TTL_MINUTES),
    )
    db.add(token_row)
    db.commit()

    link = f"{settings.app_base_url}/auth/verify?token={raw_token}"
    if invitation:
        send_invitation_email(user.email, link)
    else:
        send_magic_link_email(user.email, link)


def _term_is_active(user: User) -> bool:
    """TEAMMEMBER only: must be within [term_start_date, term_end_date]. Other roles are unaffected."""
    if user.role.value != "teammember":
        return True
    today = datetime.utcnow().date()
    if user.term_start_date and today < user.term_start_date:
        return False
    if user.term_end_date and today > user.term_end_date:
        return False
    return True


@router.post("/magic-link")
def request_magic_link(payload: MagicLinkRequest, db: Session = Depends(get_db)):
    """
    Always returns a generic success message, whether or not the email
    matches a user — this avoids leaking which addresses have accounts.
    A TEAMMEMBER outside their active term is silently denied a link
    (same generic response), rather than being told why.
    """
    user = db.query(User).filter(User.email == payload.email).first()

    if user and _term_is_active(user):
        issue_magic_link(db, user, invitation=False)
        log_audit_event(db, user.id, "magic_link_requested", resource_type="user", resource_id=user.id)
    elif user:
        log_audit_event(
            db, user.id, "magic_link_denied",
            resource_type="user", resource_id=user.id, details="term_not_active",
        )
    else:
        log_audit_event(
            db, None, "magic_link_denied",
            resource_type="user", details=f"no_account email={payload.email}",
        )

    return {"message": "If that email is registered, a sign-in link has been sent."}


@router.get("/verify")
def verify_magic_link(token: str, response: Response, db: Session = Depends(get_db)):
    token_hash = _hash_token(token)
    token_row = (
        db.query(MagicLinkToken)
        .filter(MagicLinkToken.token_hash == token_hash)
        .first()
    )

    if not token_row:
        log_audit_event(db, None, "login_denied", details="invalid_token")
        raise HTTPException(status_code=400, detail="Invalid or expired link")
    if token_row.used_at is not None:
        log_audit_event(db, token_row.user_id, "login_denied", details="token_already_used")
        raise HTTPException(status_code=400, detail="This link has already been used")
    if token_row.expires_at < datetime.utcnow():
        log_audit_event(db, token_row.user_id, "login_denied", details="token_expired")
        raise HTTPException(status_code=400, detail="This link has expired")

    user = db.query(User).filter(User.id == token_row.user_id).first()
    if not user:
        log_audit_event(db, None, "login_denied", details="user_not_found")
        raise HTTPException(status_code=400, detail="Invalid link")
    if not _term_is_active(user):
        log_audit_event(db, user.id, "login_denied", details="term_not_active")
        raise HTTPException(status_code=403, detail="Your term of access is not currently active")

    token_row.used_at = datetime.utcnow()
    db.commit()

    session_token = create_session_token(user_id=str(user.id), role=user.role.value)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_token,
        max_age=SESSION_MAX_AGE_SECONDS,
        httponly=True,
        samesite="lax",
        secure=settings.app_base_url.startswith("https"),
    )

    log_audit_event(db, user.id, "login")

    return {"message": "Signed in successfully", "email": user.email, "role": user.role.value}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE_NAME)
    return {"message": "Signed out"}


def get_current_user(
    ministry_session: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> User:
    """
    Dependency for role-gated routes: raises 401 if there's no valid
    session, otherwise returns the logged-in User row.
    """
    if not ministry_session:
        raise HTTPException(status_code=401, detail="Not authenticated")

    payload = read_session_token(ministry_session)
    if not payload:
        raise HTTPException(status_code=401, detail="Session invalid or expired")

    user = db.query(User).filter(User.id == payload["user_id"]).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    if not _term_is_active(user):
        log_audit_event(db, user.id, "access_denied", details="term_expired_mid_session")
        raise HTTPException(status_code=401, detail="Your term of access is no longer active")

    return user
