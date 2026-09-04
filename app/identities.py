from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Role, Identity
from app.permissions import require_role, can_decrypt_pii, log_pii_access
from app.crypto import encrypt_field, decrypt_field, blind_index
from app.audit import log_audit_event

router = APIRouter(prefix="/identities", tags=["identities"])


class IdentityCreate(BaseModel):
    full_name: str
    dob: str | None = None
    contact_info: str | None = None
    notes: str | None = None


@router.post("")
def create_identity(
    payload: IdentityCreate,
    current_user: User = Depends(require_role(Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    identity = Identity(
        encrypted_full_name=encrypt_field(payload.full_name),
        encrypted_dob=encrypt_field(payload.dob),
        encrypted_contact_info=encrypt_field(payload.contact_info),
        encrypted_notes=encrypt_field(payload.notes),
        search_hash=blind_index(payload.full_name),
    )
    db.add(identity)
    db.commit()
    db.refresh(identity)

    log_audit_event(db, current_user.id, "identity_created", resource_type="identity", resource_id=identity.id)

    return {"id": str(identity.id), "message": "Identity created"}


@router.get("/{identity_id}")
def get_identity(
    identity_id: str,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    """
    VOLUNTEER can't reach this route at all (blocked by require_role).
    ADMIN can only decrypt while actively elevated; TEAMMEMBER always can.
    Every successful decrypt is written to the PII access log.
    """
    identity = db.query(Identity).filter(Identity.id == identity_id).first()
    if not identity:
        raise HTTPException(status_code=404, detail="Identity not found")

    grant_or_true = can_decrypt_pii(current_user, db)
    if not grant_or_true:
        log_audit_event(
            db, current_user.id, "identity_view_denied",
            resource_type="identity", resource_id=identity.id,
        )
        raise HTTPException(
            status_code=403,
            detail="Not currently authorized to view PII — request elevation via /elevation/request",
        )

    elevation_grant = grant_or_true if grant_or_true is not True else None
    log_pii_access(db, current_user, identity.id, elevation_grant)
    log_audit_event(
        db, current_user.id, "identity_viewed",
        resource_type="identity", resource_id=identity.id,
        details="via_elevation" if elevation_grant else "via_teammember_role",
    )

    return {
        "id": str(identity.id),
        "full_name": decrypt_field(identity.encrypted_full_name),
        "dob": decrypt_field(identity.encrypted_dob),
        "contact_info": decrypt_field(identity.encrypted_contact_info),
        "notes": decrypt_field(identity.encrypted_notes),
    }
