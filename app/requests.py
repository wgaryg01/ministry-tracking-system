from datetime import date as date_type

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Role, Identity, AssistanceRequest, RequestDocument, RequestVote, ActivityRecord
from app.permissions import require_role, can_decrypt_pii, log_pii_access
from app.auth import get_current_user
from app.crypto import encrypt_field, decrypt_field, encrypt_bytes, decrypt_bytes
from app.audit import log_audit_event
from app.notifications import notify_team_of_new_request

router = APIRouter(tags=["requests"])

OPEN_STATUSES = {"new", "approved", "in_progress", "on_hold"}
RESOLVED_STATUSES = {"denied", "completed", "canceled"}

MAX_DOCUMENT_BYTES = 10 * 1024 * 1024  # 10MB
ALLOWED_DOCUMENT_TYPES = {
    "application/pdf", "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif",
}
ALLOWED_DOCUMENT_EXTENSIONS = (".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif")


def _document_type_allowed(content_type: str | None, filename: str) -> bool:
    if content_type in ALLOWED_DOCUMENT_TYPES:
        return True
    return filename.lower().endswith(ALLOWED_DOCUMENT_EXTENSIONS)
VALID_REQUEST_STATUSES = {"new", "approved", "denied", "in_progress", "on_hold", "completed", "canceled"}


class AssistanceRequestCreate(BaseModel):
    assistance_type: str
    situation_description: str | None = None
    status: str = "new"
    request_received_date: date_type | None = None  # defaults to today if not given
    helper_name: str | None = None
    helper_contact: str | None = None
    helper_relationship: str | None = None


class AssistanceRequestUpdate(AssistanceRequestCreate):
    pass


def _validate_status(status: str):
    if status not in VALID_REQUEST_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of: {', '.join(sorted(VALID_REQUEST_STATUSES))}")


@router.post("/identities/{identity_id}/requests")
def create_request(
    identity_id: str,
    payload: AssistanceRequestCreate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    identity = db.query(Identity).filter(Identity.id == identity_id).first()
    if not identity:
        raise HTTPException(status_code=404, detail="Identity not found")

    _validate_status(payload.status)

    req = AssistanceRequest(
        identity_id=identity.id,
        encrypted_assistance_type=encrypt_field(payload.assistance_type),
        encrypted_situation_description=encrypt_field(payload.situation_description),
        status=payload.status,
        acknowledged_date=payload.request_received_date or date_type.today(),
        encrypted_helper_name=encrypt_field(payload.helper_name),
        encrypted_helper_contact=encrypt_field(payload.helper_contact),
        encrypted_helper_relationship=encrypt_field(payload.helper_relationship),
        created_by_user_id=current_user.id,
    )
    db.add(req)
    db.commit()
    db.refresh(req)

    log_audit_event(
        db, current_user.id, "request_created",
        resource_type="assistance_request", resource_id=req.id, details=f"identity_id={identity.id}",
    )

    notify_team_of_new_request(db, req, identity, excluding_user_id=current_user.id)

    return {"id": str(req.id), "message": "Request created"}


@router.put("/requests/{request_id}")
def update_request(
    request_id: str,
    payload: AssistanceRequestUpdate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    req = db.query(AssistanceRequest).filter(AssistanceRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")

    req.encrypted_assistance_type = encrypt_field(payload.assistance_type)
    req.encrypted_situation_description = encrypt_field(payload.situation_description)
    _validate_status(payload.status)
    req.status = payload.status
    req.applicant_acknowledged = False
    req.acknowledged_date = payload.request_received_date or req.acknowledged_date
    req.encrypted_helper_name = encrypt_field(payload.helper_name)
    req.encrypted_helper_contact = encrypt_field(payload.helper_contact)
    req.encrypted_helper_relationship = encrypt_field(payload.helper_relationship)
    db.commit()

    log_audit_event(db, current_user.id, "request_updated", resource_type="assistance_request", resource_id=req.id)

    return {"message": "Request updated"}


@router.post("/requests/{request_id}/documents")
async def upload_document(
    request_id: str,
    file: UploadFile = File(...),
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    req = db.query(AssistanceRequest).filter(AssistanceRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")

    if not _document_type_allowed(file.content_type, file.filename):
        raise HTTPException(status_code=400, detail="Only images and PDF files are allowed")

    data = await file.read()
    if len(data) > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=400, detail="File must be under 10MB")

    doc = RequestDocument(
        assistance_request_id=req.id,
        filename=file.filename,
        content_type=file.content_type,
        encrypted_file_data=encrypt_bytes(data),
        uploaded_by_user_id=current_user.id,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    log_audit_event(
        db, current_user.id, "document_uploaded",
        resource_type="assistance_request", resource_id=req.id, details=f"filename={file.filename}",
    )

    return {"id": str(doc.id), "filename": doc.filename, "message": "Document uploaded"}


@router.get("/requests/{request_id}/documents/{document_id}")
def download_document(
    request_id: str,
    document_id: str,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    doc = (
        db.query(RequestDocument)
        .filter(RequestDocument.id == document_id, RequestDocument.assistance_request_id == request_id)
        .first()
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    req = db.query(AssistanceRequest).filter(AssistanceRequest.id == request_id).first()

    grant_or_true = can_decrypt_pii(current_user, db)
    if not grant_or_true:
        log_audit_event(
            db, current_user.id, "document_view_denied",
            resource_type="assistance_request", resource_id=request_id,
        )
        raise HTTPException(status_code=403, detail="Not currently authorized to view documents")

    elevation_grant = grant_or_true if grant_or_true is not True else None
    if req:
        log_pii_access(db, current_user, req.identity_id, elevation_grant)
    log_audit_event(
        db, current_user.id, "document_viewed",
        resource_type="assistance_request", resource_id=request_id, details=f"filename={doc.filename}",
    )

    data = decrypt_bytes(doc.encrypted_file_data)
    return Response(
        content=data,
        media_type=doc.content_type or "application/octet-stream",
        headers={"Content-Disposition": f'inline; filename="{doc.filename}"'},
    )


@router.delete("/requests/{request_id}/documents/{document_id}")
def delete_document(
    request_id: str,
    document_id: str,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    doc = (
        db.query(RequestDocument)
        .filter(RequestDocument.id == document_id, RequestDocument.assistance_request_id == request_id)
        .first()
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    filename = doc.filename
    db.delete(doc)
    db.commit()

    log_audit_event(
        db, current_user.id, "document_deleted",
        resource_type="assistance_request", resource_id=request_id, details=f"filename={filename}",
    )

    return {"message": "Document deleted"}


class VoteUpdate(BaseModel):
    support: bool


@router.put("/requests/{request_id}/vote")
def cast_vote(
    request_id: str,
    payload: VoteUpdate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    """
    Upserts the current user's Yes/No vote on this request — voting
    again just changes the existing vote rather than adding a second
    one. Restricted to ADMIN/TEAMMEMBER, since voting requires actually
    being able to see what's being voted on.
    """
    req = db.query(AssistanceRequest).filter(AssistanceRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")

    if req.status in RESOLVED_STATUSES:
        raise HTTPException(status_code=400, detail="Voting is closed for this request")

    vote = (
        db.query(RequestVote)
        .filter(RequestVote.assistance_request_id == request_id, RequestVote.user_id == current_user.id)
        .first()
    )
    if vote:
        vote.support = payload.support
    else:
        vote = RequestVote(assistance_request_id=request_id, user_id=current_user.id, support=payload.support)
        db.add(vote)
    db.commit()

    log_audit_event(
        db, current_user.id, "request_vote_cast",
        resource_type="assistance_request", resource_id=request_id, details=f"support={payload.support}",
    )

    return {"message": "Vote recorded"}


def _list_requests_by_status(db: Session, current_user: User, statuses: set, audit_action: str) -> list:
    grant_or_true = can_decrypt_pii(current_user, db)
    can_see_names = bool(grant_or_true)

    reqs = (
        db.query(AssistanceRequest)
        .filter(AssistanceRequest.status.in_(statuses))
        .order_by(AssistanceRequest.acknowledged_date.desc())
        .all()
    )

    results = []
    for req in reqs:
        identity = db.query(Identity).filter(Identity.id == req.identity_id).first()
        name = None
        assistance_type = None
        if can_see_names and identity:
            name = f"{decrypt_field(identity.encrypted_first_name)} {decrypt_field(identity.encrypted_last_name)}"
            assistance_type = decrypt_field(req.encrypted_assistance_type)
            log_pii_access(db, current_user, identity.id, None)

        activities = db.query(ActivityRecord).filter(ActivityRecord.assistance_request_id == req.id).all()
        total_amount = round(
            sum(float(a.amount_spent) for a in activities if a.amount_spent is not None and a.payment_approved), 2
        )

        results.append({
            "identity_id": str(req.identity_id),
            "request_id": str(req.id),
            "name": name,
            "assistance_type": assistance_type,
            "status": req.status,
            "request_received_date": req.acknowledged_date.isoformat() if req.acknowledged_date else None,
            "total_amount": total_amount,
        })

    log_audit_event(
        db, current_user.id, audit_action,
        resource_type="assistance_request", details=f"count={len(results)}",
    )

    return results


@router.get("/requests/open")
def list_open_requests(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Every request across every recipient that isn't denied, completed,
    or canceled — the working queue. Same PII gating as everywhere
    else: names/need are only shown if the requester can decrypt PII.
    """
    return _list_requests_by_status(db, current_user, OPEN_STATUSES, "open_requests_listed")


@router.get("/requests/closed")
def list_closed_requests(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Every request that's been denied, completed, or canceled."""
    return _list_requests_by_status(db, current_user, RESOLVED_STATUSES, "closed_requests_listed")
