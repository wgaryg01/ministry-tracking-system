from datetime import date as date_type, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Role
from app.permissions import require_role
from app.auth import issue_magic_link
from app.audit import log_audit_event

router = APIRouter(prefix="/users", tags=["users"])


class UserInvite(BaseModel):
    email: EmailStr
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


@router.post("/invite")
def invite_user(
    payload: UserInvite,
    current_user: User = Depends(require_role(Role.ADMIN)),
    db: Session = Depends(get_db),
):
    existing = db.query(User).filter(User.email == payload.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="A user with this email already exists")

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
    if term_start is None or term_start <= date_type.today():
        issue_magic_link(db, user, invitation=True)
        user.invitation_sent_at = datetime.utcnow()
        db.commit()
        sent_now = True
    else:
        sent_now = False

    return {
        "id": str(user.id),
        "email": user.email,
        "role": user.role.value,
        "term_start_date": term_start.isoformat() if term_start else None,
        "term_end_date": term_end.isoformat() if term_end else None,
        "invitation_sent": sent_now,
    }
