from datetime import date as date_type, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, field_validator, Field
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Role
from app.permissions import require_role
from app.auth import issue_magic_link, get_current_user
from app.audit import log_audit_event
from app.email import EmailSendError
from app.sms import SmsSendError
from app.config import settings
from app.password import hash_password, validate_password_strength

router = APIRouter(prefix="/users", tags=["users"])


class UserInvite(BaseModel):
    email: EmailStr | None = None
    phone_number: str | None = None
    role: Role
    term_start_date: date_type | None = None
    term_end_date: date_type | None = None

    @field_validator("term_end_date")
    @classmethod
    def end_after_start(cls, v, info):
        start = info.data.get("term_start_date")
        if v and start and v <= start:
            raise ValueError("term_end_date must be after term_start_date")
        return v

    @field_validator("phone_number")
    @classmethod
    def require_contact_method(cls, v, info):
        if not v and not info.data.get("email"):
            raise ValueError("Provide an email or a cell number")
        return v


@router.post("/invite")
def invite_user(
    payload: UserInvite,
    current_user: User = Depends(require_role(Role.ADMIN)),
    db: Session = Depends(get_db),
):

    # Emails no longer need to be unique — a household can share one
    # inbox across two accounts (e.g. husband and wife). Each account
    # is still distinct; they just can't both use magic-link sign-in
    # at that shared address (see /auth/magic-link) and should set a
    # password instead.

    term_start = payload.term_start_date
    term_end = payload.term_end_date

    if payload.role == Role.TEAMMEMBER:
        if not term_start or not term_end:
            raise HTTPException(
                status_code=400,
                detail="term_start_date and term_end_date are required for TEAMMEMBER accounts",
            )
    else:
        # Term limits are a TEAMMEMBER concept only — ignore if supplied for other roles.
        term_start = None
        term_end = None

    user = User(
        email=payload.email,
        phone_number=payload.phone_number,
        role=payload.role,
        term_start_date=term_start,
        term_end_date=term_end,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    log_audit_event(
        db, current_user.id, "user_invited",
        resource_type="user", resource_id=user.id,
        details=f"role={payload.role.value} term_start={term_start} term_end={term_end}",
    )

    # Send immediately if the term already starts today or earlier (or no
    # start date at all, e.g. ADMIN/VOLUNTEER). Otherwise the scheduler
    # picks it up at 8am on the actual start date.
    send_error = None
    if term_start is None or term_start <= date_type.today():
        try:
            issue_magic_link(db, user, invitation=True, also_sms=bool(user.phone_number))
            user.invitation_sent_at = datetime.utcnow()
            db.commit()
            sent_now = True
        except (EmailSendError, SmsSendError) as e:
            sent_now = False
            send_error = str(e)
            log_audit_event(
                db, current_user.id, "invitation_send_failed",
                resource_type="user", resource_id=user.id, details=send_error,
            )
    else:
        sent_now = False

    result = {
        "id": str(user.id),
        "email": user.email,
        "phone_number": user.phone_number,
        "role": user.role.value,
        "term_start_date": term_start.isoformat() if term_start else None,
        "term_end_date": term_end.isoformat() if term_end else None,
        "invitation_sent": sent_now,
    }
    if send_error:
        result["warning"] = f"User was created, but the invitation failed to send: {send_error}"
    return result


@router.get("")
def list_users(
    role: Role | None = None,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    """
    Staff roster — for populating the activity-assignment picker.
    Not client PII, but still restricted to staff (not VOLUNTEER),
    consistent with the rest of the app's information minimalism.
    """
    query = db.query(User)
    if role:
        query = query.filter(User.role == role)
    users = query.order_by(User.email).all()
    return [
        {
            "id": str(u.id),
            "email": u.email,
            "phone_number": u.phone_number,
            "username": u.username,
            "full_name": u.full_name,
            "role": u.role.value,
            "is_active": u.is_active,
            "term_start_date": u.term_start_date.isoformat() if u.term_start_date else None,
            "term_end_date": u.term_end_date.isoformat() if u.term_end_date else None,
        }
        for u in users
    ]


class MyInfoUpdate(BaseModel):
    full_name: str | None = None
    username: str | None = None
    email: EmailStr
    phone_number: str | None = None
    notify_email: bool = True
    notify_sms: bool = False


@router.get("/me")
def get_my_info(current_user: User = Depends(get_current_user)):
    return {
        "full_name": current_user.full_name,
        "username": current_user.username,
        "email": current_user.email,
        "phone_number": current_user.phone_number,
        "notify_email": current_user.notify_email,
        "notify_sms": current_user.notify_sms,
        "sms_available": settings.twilio_configured,
    }


@router.put("/me")
def update_my_info(
    payload: MyInfoUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if payload.email != current_user.email:
        existing = db.query(User).filter(User.email == payload.email).first()
        if existing:
            raise HTTPException(status_code=400, detail="That email is already in use by another account")
        current_user.email = payload.email

    if payload.username and payload.username != current_user.username:
        existing = db.query(User).filter(User.username == payload.username, User.id != current_user.id).first()
        if existing:
            raise HTTPException(status_code=400, detail="That username is already taken")
        current_user.username = payload.username

    current_user.full_name = payload.full_name
    current_user.phone_number = payload.phone_number
    current_user.notify_email = payload.notify_email
    current_user.notify_sms = payload.notify_sms
    db.commit()

    log_audit_event(db, current_user.id, "user_updated_own_info", resource_type="user", resource_id=current_user.id)

    return {
        "full_name": current_user.full_name,
        "username": current_user.username,
        "email": current_user.email,
        "phone_number": current_user.phone_number,
        "notify_email": current_user.notify_email,
        "notify_sms": current_user.notify_sms,
    }


class AccountSetup(BaseModel):
    full_name: str
    email: EmailStr
    phone_number: str | None = None
    password: str
    notify_email: bool = True
    notify_sms: bool = False
    username: str | None = None  # only needed if the email-based default collides


@router.post("/me/setup")
def complete_account_setup(
    payload: AccountSetup,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    The form an invited person fills out the first time they use their
    invitation link — name, email, phone, password, and contact
    preferences all at once. Username isn't shown as a field normally;
    it defaults to their email behind the scenes. It only surfaces if
    that collides (a second person sharing the same email as another
    account already using it to sign in), in which case the frontend
    asks for a distinct one and resubmits with `username` set.
    """
    strength_error = validate_password_strength(payload.password)
    if strength_error:
        raise HTTPException(status_code=400, detail=strength_error)

    desired_username = payload.username or payload.email
    existing = db.query(User).filter(User.username == desired_username, User.id != current_user.id).first()
    if existing:
        raise HTTPException(
            status_code=400,
            detail="That login ID is already taken by another account — please choose a different one",
        )

    current_user.full_name = payload.full_name
    current_user.email = payload.email
    current_user.phone_number = payload.phone_number
    current_user.notify_email = payload.notify_email
    current_user.notify_sms = payload.notify_sms
    current_user.username = desired_username
    current_user.password_hash = hash_password(payload.password)
    db.commit()

    log_audit_event(db, current_user.id, "account_setup_completed", resource_type="user", resource_id=current_user.id)

    return {"message": "Account set up", "username": current_user.username}


class PasswordSet(BaseModel):
    new_password: str


@router.put("/me/password")
def set_my_password(
    payload: PasswordSet,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Setting a password is mainly for household-shared-email accounts,
    where magic link can't tell which person is signing in. Being
    already authenticated (via a working magic-link session) is
    sufficient trust to set a new password — no separate re-auth step,
    consistent with how email changes work in PUT /users/me.
    """
    strength_error = validate_password_strength(payload.new_password)
    if strength_error:
        raise HTTPException(status_code=400, detail=strength_error)

    current_user.password_hash = hash_password(payload.new_password)
    db.commit()

    log_audit_event(db, current_user.id, "password_set", resource_type="user", resource_id=current_user.id)

    return {"message": "Password updated"}


class UserManageUpdate(BaseModel):
    role: Role
    term_start_date: date_type | None = None
    term_end_date: date_type | None = None
    is_active: bool = True


@router.put("/{user_id}")
def manage_user(
    user_id: str,
    payload: UserManageUpdate,
    current_user: User = Depends(require_role(Role.ADMIN)),
    db: Session = Depends(get_db),
):
    """
    ADMIN only — change a team member's role or deactivate their
    access. "Remove" is a soft deactivation (is_active=False), not a
    hard delete: activity records, audit log entries, and elevation
    grants all reference this account, and deleting it outright would
    break that history. A deactivated account is denied at sign-in
    and mid-session, same as an expired TEAMMEMBER term.
    """
    if user_id == str(current_user.id):
        raise HTTPException(status_code=400, detail="Use My Info to edit your own account")

    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    if payload.role == Role.TEAMMEMBER:
        if not payload.term_start_date or not payload.term_end_date:
            raise HTTPException(
                status_code=400,
                detail="term_start_date and term_end_date are required for TEAMMEMBER accounts",
            )
        term_start, term_end = payload.term_start_date, payload.term_end_date
    else:
        term_start, term_end = None, None

    old_role = target.role.value
    target.role = payload.role
    target.term_start_date = term_start
    target.term_end_date = term_end
    target.is_active = payload.is_active
    db.commit()

    log_audit_event(
        db, current_user.id, "user_managed",
        resource_type="user", resource_id=target.id,
        details=f"role_changed={old_role}->{payload.role.value} active={payload.is_active}",
    )

    return {"message": "User updated"}
