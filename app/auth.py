import hashlib
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response, Cookie
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, MagicLinkToken, Role
from app.email import send_magic_link_email, send_invitation_email, EmailSendError
from app.sms import send_sms, SmsSendError
from app.session import create_session_token, read_session_token, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS
from app.config import settings
from app.audit import log_audit_event
from app.password import verify_password

router = APIRouter(prefix="/auth", tags=["auth"])

TOKEN_TTL_MINUTES = 15
MAX_FAILED_LOGIN_ATTEMPTS = 5
LOCKOUT_MINUTES = 15


class MagicLinkRequest(BaseModel):
    email: EmailStr


class LoginRequest(BaseModel):
    username: str
    password: str


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode()).hexdigest()


def issue_magic_link(db: Session, user: User, invitation: bool = False, also_sms: bool = False) -> None:
    """
    Shared by: (a) first-time invitation links, and (b) the second
    factor sent after a successful username/password check. Both
    create a single-use, 15-minute token — the same token is sent over
    every requested channel, so whichever one the person actually
    checks works interchangeably. `invitation` only changes the email
    template; `also_sms` additionally texts the same link if the user
    has opted into SMS and Twilio is configured. If the account has no
    email at all (invited by phone number only), the SMS becomes the
    only delivery channel — also_sms is treated as required in that case.
    """
    raw_token = secrets.token_urlsafe(32)
    token_row = MagicLinkToken(
        user_id=user.id,
        token_hash=_hash_token(raw_token),
        expires_at=datetime.utcnow() + timedelta(minutes=TOKEN_TTL_MINUTES),
    )
    db.add(token_row)
    db.commit()

    link = f"{settings.app_base_url}/verify?token={raw_token}"
    if user.email:
        if invitation:
            send_invitation_email(user.email, link)
        else:
            send_magic_link_email(user.email, link)

    sms_wanted = also_sms or not user.email
    if sms_wanted and settings.twilio_configured and user.phone_number:
        try:
            send_sms(user.phone_number, f"Your sign-in link (expires in 15 min): {link}")
        except SmsSendError:
            if not user.email:
                raise  # SMS was the only channel — this failure must surface
            # else: email already succeeded, SMS was just a bonus — don't fail the whole flow over it
    elif not user.email:
        # No email, and SMS isn't usable either (not configured, or no phone on file) — nothing was sent.
        raise EmailSendError("No usable contact method: no email on file, and SMS is unavailable")


def _term_is_active(user: User) -> bool:
    """
    Every role: must be is_active. TEAMMEMBER additionally: must be
    within [term_start_date, term_end_date]. Name kept as-is since
    it's used throughout login/session checks; it now covers both
    the manual active/inactive switch and term limits.
    """
    if not user.is_active:
        return False
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
    Bootstrap path only — for an account that hasn't finished setting
    up a username/password yet (e.g. right after being invited).
    Once an account has a password, this path declines and the
    account must use POST /auth/login (username + password) instead,
    which sends this same kind of link as the second factor. Always
    returns a generic message either way, so it never reveals which
    accounts exist, how many share this email, or which state they're in.
    """
    matches = db.query(User).filter(User.email == payload.email).all()
    generic = {"message": "If that email is registered and not yet set up, a sign-in link has been sent."}

    bootstrap_eligible = [u for u in matches if not u.password_hash]

    if len(bootstrap_eligible) == 1 and _term_is_active(bootstrap_eligible[0]):
        user = bootstrap_eligible[0]
        try:
            issue_magic_link(db, user, invitation=False)
            log_audit_event(db, user.id, "magic_link_requested", resource_type="user", resource_id=user.id)
        except EmailSendError as e:
            log_audit_event(
                db, user.id, "magic_link_send_failed",
                resource_type="user", resource_id=user.id, details=str(e),
            )
    elif len(bootstrap_eligible) > 1:
        log_audit_event(
            db, None, "magic_link_denied",
            resource_type="user", details=f"shared_email_ambiguous email={payload.email} count={len(bootstrap_eligible)}",
        )
    elif matches:
        # Every match already has a password set — this is the expected
        # state after setup, not an error; direct them to the real login.
        log_audit_event(
            db, None, "magic_link_denied",
            resource_type="user", details=f"password_already_set email={payload.email}",
        )
    else:
        log_audit_event(
            db, None, "magic_link_denied",
            resource_type="user", details=f"no_account email={payload.email}",
        )

    return generic


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

    log_audit_event(db, user.id, "login", details="via_magic_link")

    return {"message": "Signed in successfully", "email": user.email, "role": user.role.value}


@router.post("/login")
def login_step_one(payload: LoginRequest, db: Session = Depends(get_db)):
    """
    First factor only — verifies username + password, then sends a
    second-factor link (email, and SMS too if the user has opted in
    and Twilio is configured). No session is created here; that only
    happens once GET /auth/verify confirms the emailed/texted token.
    Always returns the same generic message, whether or not the
    username exists or the password matched, to avoid leaking either.
    """
    generic = {"message": "If those credentials are correct, a verification link has been sent."}

    user = db.query(User).filter(User.username == payload.username).first()

    if user and user.locked_until and user.locked_until > datetime.utcnow():
        # Still locked out — don't even attempt password verification,
        # and don't reveal that locking is the reason (same generic
        # response either way, so an attacker can't distinguish
        # "wrong password" from "this account is currently locked").
        log_audit_event(db, user.id, "login_denied", details="account_locked")
        return generic

    if not user or not user.password_hash or not verify_password(payload.password, user.password_hash):
        if user:
            user.failed_login_attempts = (user.failed_login_attempts or 0) + 1
            if user.failed_login_attempts >= MAX_FAILED_LOGIN_ATTEMPTS:
                user.locked_until = datetime.utcnow() + timedelta(minutes=LOCKOUT_MINUTES)
                user.failed_login_attempts = 0
                log_audit_event(db, user.id, "account_locked", details=f"after {MAX_FAILED_LOGIN_ATTEMPTS} failed attempts")
            db.commit()
        log_audit_event(db, user.id if user else None, "login_denied", details="password_mismatch")
        return generic

    # Successful password check — clear any prior failure tracking.
    user.failed_login_attempts = 0
    user.locked_until = None
    db.commit()

    if not _term_is_active(user):
        log_audit_event(db, user.id, "login_denied", details="term_not_active")
        return generic

    try:
        issue_magic_link(db, user, invitation=False, also_sms=user.notify_sms)
        log_audit_event(db, user.id, "second_factor_sent", resource_type="user", resource_id=user.id)
    except EmailSendError as e:
        log_audit_event(
            db, user.id, "second_factor_send_failed",
            resource_type="user", resource_id=user.id, details=str(e),
        )

    return generic


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


@router.get("/me")
def get_me(current_user: User = Depends(get_current_user)):
    return {
        "id": str(current_user.id),
        "email": current_user.email,
        "role": current_user.role.value,
        "full_name": current_user.full_name,
        "username": current_user.username,
        "needs_setup": not bool(current_user.username and current_user.password_hash),
    }


ONLINE_THRESHOLD_SECONDS = 90  # ~3x the ~30s heartbeat interval, tolerates a couple missed beats


@router.post("/heartbeat")
def send_global_heartbeat(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Site-wide "who's online" — separate from per-record presence.
    Called continuously in the background while the app is open,
    regardless of which page is showing.
    """
    current_user.last_active_at = datetime.utcnow()
    db.commit()

    cutoff = datetime.utcnow() - timedelta(seconds=ONLINE_THRESHOLD_SECONDS)
    others = (
        db.query(User)
        .filter(User.id != current_user.id, User.last_active_at != None, User.last_active_at >= cutoff)
        .all()
    )
    return {
        "others_online": [
            {"name": u.full_name or u.email or u.username, "role": _role_label(u.role)} for u in others
        ]
    }


def _role_label(role: Role) -> str:
    return "deacon" if role == Role.VOLUNTEER else role.value
