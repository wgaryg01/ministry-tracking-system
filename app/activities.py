from datetime import date as date_type

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Role, ActivityRecord, Identity
from app.permissions import require_role
from app.auth import get_current_user
from app.audit import log_audit_event

router = APIRouter(prefix="/activities", tags=["activities"])


class ActivityCreate(BaseModel):
    identity_id: str
    activity_date: date_type | None = None
    amount_spent: float | None = None
    category: str | None = None


@router.post("")
def create_activity(
    payload: ActivityCreate,
    current_user: User = Depends(require_role(Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    identity = db.query(Identity).filter(Identity.id == payload.identity_id).first()
    if not identity:
        raise HTTPException(status_code=404, detail="Identity not found")

    activity = ActivityRecord(
        identity_id=identity.id,
        activity_date=payload.activity_date or date_type.today(),
        amount_spent=payload.amount_spent,
        category=payload.category,
        logged_by_user_id=current_user.id,
    )
    db.add(activity)
    db.commit()
    db.refresh(activity)

    log_audit_event(
        db, current_user.id, "activity_created",
        resource_type="activity_record", resource_id=activity.id,
        details=f"identity_id={identity.id} category={payload.category}",
    )

    return {"id": str(activity.id), "message": "Activity logged"}


@router.get("")
def list_activities(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Available to every authenticated role, including VOLUNTEER — but
    deliberately returns no PII. identity_id is included so repeat
    help for the same person is visible; resolving it to a name
    requires a separate call to GET /identities/{id}, which enforces
    decrypt permission and logs the access.
    """
    activities = db.query(ActivityRecord).order_by(ActivityRecord.activity_date.desc()).all()

    log_audit_event(
        db, current_user.id, "activities_listed",
        resource_type="activity_record", details=f"count={len(activities)}",
    )

    return [
        {
            "id": str(a.id),
            "identity_id": str(a.identity_id),
            "activity_date": a.activity_date.isoformat(),
            "amount_spent": float(a.amount_spent) if a.amount_spent is not None else None,
            "category": a.category,
        }
        for a in activities
    ]
