import hashlib
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response, Cookie
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, MagicLinkToken
from app.email import send_magic_link_email
from app.session import create_session_token, read_session_token, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS
from app.config import settings

router = APIRouter(prefix="/auth", tags=["auth"])

TOKEN_TTL_MINUTES = 15


class MagicLinkRequest(BaseModel):
    email: EmailStr


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode()).hexdigest()


@router.post("/magic-link")
def request_magic_link(payload: MagicLinkRequest, db: Session = Depends(get_db)):
    """
    Always returns a generic success message, whether or not the email
    matches a user — this avoids leaking which addresses have accounts.
    """
    user = db.query(User).filter(User.email == payload.email).first()

    if user:
        raw_token = secrets.token_urlsafe(32)
        token_row = MagicLinkToken(
            user_id=user.id,
            token_hash=_hash_token(raw_token),
            expires_at=datetime.utcnow() + timedelta(minutes=TOKEN_TTL_MINUTES),
        )
        db.add(token_row)
        db.commit()

        link = f"{settings.app_base_url}/auth/verify?token={raw_token}"
        send_magic_link_email(user.email, link)

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
        raise HTTPException(status_code=400, detail="Invalid or expired link")
    if token_row.used_at is not None:
        raise HTTPException(status_code=400, detail="This link has already been used")
    if token_row.expires_at < datetime.utcnow():
        raise HTTPException(status_code=400, detail="This link has expired")

    user = db.query(User).filter(User.id == token_row.user_id).first()
    if not user:
        raise HTTPException(status_code=400, detail="Invalid link")

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

    return user
