from datetime import date as date_type, datetime

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Role, ActivityRecord, AssistanceRequest, ActivityAssignment, NotificationRule, ActivityAttachment
from app.permissions import require_role, can_decrypt_pii, log_pii_access
from app.auth import get_current_user
from app.audit import log_audit_event
from app.crypto import encrypt_field, encrypt_bytes, decrypt_bytes

router = APIRouter(prefix="/activities", tags=["activities"])

ALLOWED_ATTACHMENT_TYPES = {
    "application/pdf", "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif",
}
ALLOWED_ATTACHMENT_EXTENSIONS = (".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif")
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024  # 10MB


def _attachment_type_allowed(content_type: str | None, filename: str) -> bool:
    if content_type in ALLOWED_ATTACHMENT_TYPES:
        return True
    # Some phone cameras/browsers report an empty or nonstandard content-type
    # for captured photos — fall back to checking the filename extension.
    return filename.lower().endswith(ALLOWED_ATTACHMENT_EXTENSIONS)

VALID_STATUSES = {"scheduled", "completed", "cancelled"}


class ActivityCreate(BaseModel):
    assistance_request_id: str
    activity_date: date_type | None = None
    amount_spent: float | None = None
    category: str | None = None
    notes: str | None = None
    status: str = "completed"  # "scheduled" | "completed" | "cancelled"
    scheduled_at: datetime | None = None  # required if notification offsets are given
    assigned_user_ids: list[str] = []
    notification_offsets_minutes: list[int] = []
    payment_approved: bool = False  # an amount is just a quote until this is true


class ActivityUpdate(BaseModel):
    activity_date: date_type | None = None
    amount_spent: float | None = None
    category: str | None = None
    notes: str | None = None
    status: str = "completed"
    scheduled_at: datetime | None = None
    assigned_user_ids: list[str] = []
    notification_offsets_minutes: list[int] = []
    payment_approved: bool = False
    # assistance_request_id is deliberately not editable here — moving
    # an activity to a different request is a different, riskier
    # operation than correcting its amount/category/date.


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
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
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
    activity.payment_approved = payload.payment_approved
    db.commit()

    _apply_assignments_and_rules(db, activity.id, payload.assigned_user_ids, payload.notification_offsets_minutes)

    log_audit_event(
        db, current_user.id, "activity_updated",
        resource_type="activity_record", resource_id=activity.id,
        details=f"assistance_request_id={activity.assistance_request_id} category={payload.category} status={payload.status}",
    )

    return {"message": "Activity updated"}


@router.post("")
def create_activity(
    payload: ActivityCreate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    req = db.query(AssistanceRequest).filter(AssistanceRequest.id == payload.assistance_request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Assistance request not found")

    if req.status in ("denied", "completed", "canceled"):
        raise HTTPException(status_code=400, detail="This request is closed \u2014 activities can no longer be added")

    _validate_scheduling(payload.status, payload.scheduled_at, payload.notification_offsets_minutes)

    activity = ActivityRecord(
        assistance_request_id=req.id,
        activity_date=payload.activity_date or date_type.today(),
        amount_spent=payload.amount_spent,
        category=payload.category,
        encrypted_notes=encrypt_field(payload.notes) if payload.notes else None,
        status=payload.status,
        scheduled_at=payload.scheduled_at,
        payment_approved=payload.payment_approved,
        logged_by_user_id=current_user.id,
    )
    db.add(activity)
    db.commit()
    db.refresh(activity)

    _apply_assignments_and_rules(db, activity.id, payload.assigned_user_ids, payload.notification_offsets_minutes)

    log_audit_event(
        db, current_user.id, "activity_created",
        resource_type="activity_record", resource_id=activity.id,
        details=f"assistance_request_id={req.id} category={payload.category} status={payload.status}",
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
    assistance_request_id is included so repeat help under the same
    request is visible; resolving it to a name requires a separate
    call that enforces decrypt permission and logs the access.
    """
    activities = db.query(ActivityRecord).order_by(ActivityRecord.activity_date.desc()).all()

    log_audit_event(
        db, current_user.id, "activities_listed",
        resource_type="activity_record", details=f"count={len(activities)}",
    )

    return [
        {
            "id": str(a.id),
            "assistance_request_id": str(a.assistance_request_id),
            "activity_date": a.activity_date.isoformat(),
            "amount_spent": float(a.amount_spent) if a.amount_spent is not None else None,
            "category": a.category,
            "status": a.status,
            "payment_approved": a.payment_approved,
        }
        for a in activities
    ]


@router.post("/{activity_id}/attachments")
async def upload_activity_attachment(
    activity_id: str,
    file: UploadFile = File(...),
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    activity = db.query(ActivityRecord).filter(ActivityRecord.id == activity_id).first()
    if not activity:
        raise HTTPException(status_code=404, detail="Activity not found")

    if not _attachment_type_allowed(file.content_type, file.filename):
        raise HTTPException(status_code=400, detail="Only images and PDF files are allowed")

    data = await file.read()
    if len(data) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=400, detail="File must be under 10MB")

    attachment = ActivityAttachment(
        activity_id=activity.id,
        filename=file.filename,
        content_type=file.content_type,
        encrypted_file_data=encrypt_bytes(data),
        uploaded_by_user_id=current_user.id,
    )
    db.add(attachment)
    db.commit()
    db.refresh(attachment)

    log_audit_event(
        db, current_user.id, "activity_attachment_uploaded",
        resource_type="activity_record", resource_id=activity.id, details=f"filename={file.filename}",
    )

    return {"id": str(attachment.id), "filename": attachment.filename, "content_type": attachment.content_type}


@router.get("/{activity_id}/attachments/{attachment_id}")
def view_activity_attachment(
    activity_id: str,
    attachment_id: str,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    attachment = (
        db.query(ActivityAttachment)
        .filter(ActivityAttachment.id == attachment_id, ActivityAttachment.activity_id == activity_id)
        .first()
    )
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    activity = db.query(ActivityRecord).filter(ActivityRecord.id == activity_id).first()
    req = db.query(AssistanceRequest).filter(AssistanceRequest.id == activity.assistance_request_id).first() if activity else None

    grant_or_true = can_decrypt_pii(current_user, db)
    if not grant_or_true:
        log_audit_event(
            db, current_user.id, "activity_attachment_view_denied",
            resource_type="activity_record", resource_id=activity_id,
        )
        raise HTTPException(status_code=403, detail="Not currently authorized to view attachments")

    elevation_grant = grant_or_true if grant_or_true is not True else None
    if req:
        log_pii_access(db, current_user, req.identity_id, elevation_grant)
    log_audit_event(
        db, current_user.id, "activity_attachment_viewed",
        resource_type="activity_record", resource_id=activity_id, details=f"filename={attachment.filename}",
    )

    data = decrypt_bytes(attachment.encrypted_file_data)
    # inline (not attachment) disposition — so it displays in a popup/embed rather than downloading
    return Response(
        content=data,
        media_type=attachment.content_type or "application/octet-stream",
        headers={"Content-Disposition": f'inline; filename="{attachment.filename}"'},
    )


@router.delete("/{activity_id}/attachments/{attachment_id}")
def delete_activity_attachment(
    activity_id: str,
    attachment_id: str,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    attachment = (
        db.query(ActivityAttachment)
        .filter(ActivityAttachment.id == attachment_id, ActivityAttachment.activity_id == activity_id)
        .first()
    )
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    filename = attachment.filename
    db.delete(attachment)
    db.commit()

    log_audit_event(
        db, current_user.id, "activity_attachment_deleted",
        resource_type="activity_record", resource_id=activity_id, details=f"filename={filename}",
    )

    return {"message": "Attachment deleted"}


class PaymentApprovalUpdate(BaseModel):
    payment_approved: bool


@router.put("/{activity_id}/payment-approval")
def set_payment_approval(
    activity_id: str,
    payload: PaymentApprovalUpdate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    """
    A lightweight, single-purpose toggle so approving/unapproving an
    amount for payment doesn't require resubmitting the whole activity
    form — matches the row-level checkbox in the UI.
    """
    activity = db.query(ActivityRecord).filter(ActivityRecord.id == activity_id).first()
    if not activity:
        raise HTTPException(status_code=404, detail="Activity not found")

    req = db.query(AssistanceRequest).filter(AssistanceRequest.id == activity.assistance_request_id).first()
    if req and req.status in ("denied", "completed", "canceled"):
        raise HTTPException(status_code=400, detail="This request is closed \u2014 payment approval can no longer be changed")

    activity.payment_approved = payload.payment_approved
    db.commit()

    log_audit_event(
        db, current_user.id, "activity_payment_approval_changed",
        resource_type="activity_record", resource_id=activity.id,
        details=f"payment_approved={payload.payment_approved}",
    )

    return {"message": "Updated", "payment_approved": activity.payment_approved}
