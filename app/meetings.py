from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Role, MeetingNote, MeetingAttendance, AuditLog
from app.permissions import require_role, can_decrypt_pii
from app.auth import get_current_user
from app.crypto import encrypt_field, decrypt_field
from app.audit import log_audit_event

router = APIRouter(prefix="/meetings", tags=["meetings"])


class MeetingCreate(BaseModel):
    meeting_datetime: datetime
    duration_minutes: int | None = None
    location: str | None = None
    summary: str | None = None
    redacted_transcript: str | None = None
    raw_transcript: str | None = None
    attendee_user_ids: list[str] = []


class MeetingUpdate(MeetingCreate):
    pass


def _save_attendees(db: Session, meeting_id, user_ids: list[str]):
    """
    Deacons (Role.VOLUNTEER) aren't permitted in these meetings at all
    — silently drop any such id rather than erroring, since the
    frontend already excludes them from the picker and this is just
    the server-side backstop.
    """
    if user_ids:
        eligible = {
            str(u.id) for u in db.query(User).filter(User.id.in_(user_ids), User.role != Role.VOLUNTEER).all()
        }
        for user_id in user_ids:
            if user_id in eligible:
                db.add(MeetingAttendance(meeting_id=meeting_id, user_id=user_id))


def _meeting_out(m: MeetingNote, db: Session, can_see_pii: bool) -> dict:
    attendee_rows = db.query(MeetingAttendance).filter(MeetingAttendance.meeting_id == m.id).all()
    attendee_ids = [str(a.user_id) for a in attendee_rows]
    attendee_users = db.query(User).filter(User.id.in_([a.user_id for a in attendee_rows])).all() if attendee_rows else []
    attendee_names = [u.full_name or u.email or u.username for u in attendee_users]

    return {
        "id": str(m.id),
        "meeting_datetime": m.meeting_datetime.isoformat(),
        "duration_minutes": m.duration_minutes,
        "location": m.location,
        "summary": m.summary,
        "redacted_transcript": m.redacted_transcript,
        "raw_transcript": decrypt_field(m.encrypted_raw_transcript) if (can_see_pii and m.encrypted_raw_transcript) else None,
        "has_raw_transcript": m.encrypted_raw_transcript is not None,
        "attendee_user_ids": attendee_ids,
        "attendee_names": attendee_names,
    }


@router.get("")
def list_meetings(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Newest first. Everyone can see date/time/location/summary/
    attendance/redacted transcript — only the raw transcript is
    gated behind PII-decrypt permission (ADMIN/TEAMMEMBER).
    """
    can_see_pii = bool(can_decrypt_pii(current_user, db))
    meetings = db.query(MeetingNote).order_by(MeetingNote.meeting_datetime.desc()).all()

    for m in meetings:
        log_audit_event(
            db, current_user.id, "meeting_viewed",
            resource_type="meeting_note", resource_id=m.id,
        )
        if can_see_pii and m.encrypted_raw_transcript:
            log_audit_event(
                db, current_user.id, "meeting_raw_transcript_viewed",
                resource_type="meeting_note", resource_id=m.id,
            )

    return [_meeting_out(m, db, can_see_pii) for m in meetings]


@router.post("")
def create_meeting(
    payload: MeetingCreate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    meeting = MeetingNote(
        meeting_datetime=payload.meeting_datetime,
        duration_minutes=payload.duration_minutes,
        location=payload.location,
        summary=payload.summary,
        redacted_transcript=payload.redacted_transcript,
        encrypted_raw_transcript=encrypt_field(payload.raw_transcript) if payload.raw_transcript else None,
        created_by_user_id=current_user.id,
    )
    db.add(meeting)
    db.commit()
    db.refresh(meeting)

    _save_attendees(db, meeting.id, payload.attendee_user_ids)
    db.commit()

    log_audit_event(
        db, current_user.id, "meeting_created",
        resource_type="meeting_note", resource_id=meeting.id,
    )

    return {"id": str(meeting.id), "message": "Meeting created"}


@router.put("/{meeting_id}")
def update_meeting(
    meeting_id: str,
    payload: MeetingUpdate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    meeting = db.query(MeetingNote).filter(MeetingNote.id == meeting_id).first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")

    meeting.meeting_datetime = payload.meeting_datetime
    meeting.duration_minutes = payload.duration_minutes
    meeting.location = payload.location
    meeting.summary = payload.summary
    meeting.redacted_transcript = payload.redacted_transcript
    if payload.raw_transcript is not None:
        meeting.encrypted_raw_transcript = encrypt_field(payload.raw_transcript)
    db.commit()

    db.query(MeetingAttendance).filter(MeetingAttendance.meeting_id == meeting.id).delete()
    _save_attendees(db, meeting.id, payload.attendee_user_ids)
    db.commit()

    log_audit_event(
        db, current_user.id, "meeting_updated",
        resource_type="meeting_note", resource_id=meeting.id,
    )

    return {"message": "Meeting updated"}


@router.get("/{meeting_id}/logs")
def get_meeting_logs(
    meeting_id: str,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    """Who viewed and edited this meeting, newest first."""
    meeting = db.query(MeetingNote).filter(MeetingNote.id == meeting_id).first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")

    rows = (
        db.query(AuditLog, User.email)
        .outerjoin(User, AuditLog.user_id == User.id)
        .filter(AuditLog.resource_type == "meeting_note", AuditLog.resource_id == meeting_id)
        .order_by(AuditLog.created_at.desc())
        .all()
    )
    return [
        {
            "action": log.action,
            "user_email": email or "System",
            "details": log.details,
            "created_at": log.created_at.isoformat() if log.created_at else None,
        }
        for log, email in rows
    ]
