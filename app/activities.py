from datetime import date as date_type, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Role, ActivityRecord, Identity, ActivityAssignment, NotificationRule
from app.permissions import require_role
from app.auth import get_current_user
from app.audit import log_audit_event
from app.crypto import encrypt_field

router = APIRouter(prefix="/activities", tags=["activities"])

VALID_STATUSES = {"scheduled", "completed", "cancelled"}


class ActivityCreate(BaseModel):
    identity_id: str
    activity_date: date_type | None = None
    amount_spent: float | None = None
    category: str | None = None
    notes: str | None = None
    status: str = "completed"  # "scheduled" | "completed" | "cancelled"
    scheduled_at: datetime | None = None  # required if notification offsets are given
    assigned_user_ids: list[str] = []
    notification_offsets_minutes: list[int] = []


class ActivityUpdate(BaseModel):
    activity_date: date_type | None = None
    amount_spent: float | None = None
    category: str | None = None
    notes: str | None = None
    status: str = "completed"
    scheduled_at: datetime | None = None
    assigned_user_ids: list[str] = []
    notification_offsets_minutes: list[int] = []
    # identity_id is deliberately not editable here — reassigning an
    # activity to a different person is a different, riskier operation
    # than correcting its amount/category/date.


def _validate_scheduling(status: str, scheduled_at, offsets: list[int]):
    if status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of: {', '.join(VALID_STATUSES)}")
    if offsets and not scheduled_at:
        raise HTTPException(status_code=400, detail="scheduled_at is required to set notification offsets")


def _apply_assignments_and_rules(db: Session, activity_id, assigned_user_ids: list[str], offsets: list[int]):
    """Replace-all semantics — used by both create and update."""
    db.query(ActivityAssignment).filter(ActivityAssignment.activity_id == activity_id).delete()
    db.query(NotificationRule).filter(NotificationRule.activity_id == activity_id).delete()
    for uid in assigned_user_ids:
        db.add(ActivityAssignment(activity_id=activity_id, user_id=uid))
    for minutes in offsets:
        db.add(NotificationRule(activity_id=activity_id, offset_minutes=minutes))
    db.commit()


@router.put("/{activity_id}")
def update_activity(
    activity_id: str,
    payload: ActivityUpdate,
    current_user: User = Depends(require_role(Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    activity = db.query(ActivityRecord).filter(ActivityRecord.id == activity_id).first()
    if not activity:
        raise HTTPException(status_code=404, detail="Activity not found")

    _validate_scheduling(payload.status, payload.scheduled_at, payload.notification_offsets_minutes)

    activity.activity_date = payload.activity_date or activity.activity_date
    activity.amount_spent = payload.amount_spent
    activity.category = payload.category
    activity.encrypted_notes = encrypt_field(payload.notes) if payload.notes else None
    activity.status = payload.status
    activity.scheduled_at = payload.scheduled_at
    db.commit()

    _apply_assignments_and_rules(db, activity.id, payload.assigned_user_ids, payload.notification_offsets_minutes)

    log_audit_event(
        db, current_user.id, "activity_updated",
        resource_type="activity_record", resource_id=activity.id,
        details=f"identity_id={activity.identity_id} category={payload.category} status={payload.status}",
    )

    return {"message": "Activity updated"}


@router.post("")
def create_activity(
    payload: ActivityCreate,
    current_user: User = Depends(require_role(Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    identity = db.query(Identity).filter(Identity.id == payload.identity_id).first()
    if not identity:
        raise HTTPException(status_code=404, detail="Identity not found")

    _validate_scheduling(payload.status, payload.scheduled_at, payload.notification_offsets_minutes)

    activity = ActivityRecord(
        identity_id=identity.id,
        activity_date=payload.activity_date or date_type.today(),
        amount_spent=payload.amount_spent,
        category=payload.category,
        encrypted_notes=encrypt_field(payload.notes) if payload.notes else None,
        status=payload.status,
        scheduled_at=payload.scheduled_at,
        logged_by_user_id=current_user.id,
    )
    db.add(activity)
    db.commit()
    db.refresh(activity)

    _apply_assignments_and_rules(db, activity.id, payload.assigned_user_ids, payload.notification_offsets_minutes)

    log_audit_event(
        db, current_user.id, "activity_created",
        resource_type="activity_record", resource_id=activity.id,
        details=f"identity_id={identity.id} category={payload.category} status={payload.status}",
    )

    return {"id": str(activity.id), "message": "Activity logged"}


@router.get("/categories")
def list_categories(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Distinct categories used so far, for populating a picker. Not PII — available to every role."""
    rows = (
        db.query(ActivityRecord.category)
        .filter(ActivityRecord.category.isnot(None), ActivityRecord.category != "")
        .distinct()
        .order_by(ActivityRecord.category)
        .all()
    )
    return [r[0] for r in rows]


@router.get("")
def list_activities(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Available to every authenticated role, including VOLUNTEER — but
    deliberately returns no PII (no notes, no assignment info).
    identity_id is included so repeat help for the same person is
    visible; resolving it to a name requires a separate call that
    enforces decrypt permission and logs the access.
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
            "status": a.status,
        }
        for a in activities
    ]
