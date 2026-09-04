from datetime import date as date_type

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Role, Identity, Address, AuditLog, ActivityRecord, HouseholdMember
from app.permissions import require_role, can_decrypt_pii, log_pii_access
from app.crypto import encrypt_field, decrypt_field, blind_index
from app.audit import log_audit_event
from app.household import build_household_summary

router = APIRouter(prefix="/identities", tags=["identities"])


class IdentityCreate(BaseModel):
    full_name: str
    dob: str | None = None
    contact_info: str | None = None
    notes: str | None = None
    address: str | None = None  # current physical address, if known at intake


class AddressUpdate(BaseModel):
    address: str
    effective_date: date_type | None = None  # defaults to today — the date the move took effect


class IdentityUpdate(BaseModel):
    full_name: str
    dob: str | None = None
    contact_info: str | None = None
    notes: str | None = None
    # Address is deliberately excluded — moves are recorded via
    # POST /identities/{id}/addresses, never overwritten here.


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

    if payload.address:
        address_row = Address(
            identity_id=identity.id,
            encrypted_address=encrypt_field(payload.address),
            effective_date=date_type.today(),
        )
        db.add(address_row)
        db.commit()

    log_audit_event(db, current_user.id, "identity_created", resource_type="identity", resource_id=identity.id)

    return {"id": str(identity.id), "message": "Identity created"}


@router.post("/{identity_id}/addresses")
def record_address_change(
    identity_id: str,
    payload: AddressUpdate,
    current_user: User = Depends(require_role(Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    """
    Records a move. Never overwrites a prior address — each call adds a
    new row, so the full history (with dates) is always preserved.
    """
    identity = db.query(Identity).filter(Identity.id == identity_id).first()
    if not identity:
        raise HTTPException(status_code=404, detail="Identity not found")

    address_row = Address(
        identity_id=identity.id,
        encrypted_address=encrypt_field(payload.address),
        effective_date=payload.effective_date or date_type.today(),
    )
    db.add(address_row)
    db.commit()

    log_audit_event(
        db, current_user.id, "identity_address_updated",
        resource_type="identity", resource_id=identity.id,
        details=f"effective_date={address_row.effective_date}",
    )

    return {"message": "Address recorded", "effective_date": address_row.effective_date.isoformat()}


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

    address_history = [
        {"address": decrypt_field(a.encrypted_address), "effective_date": a.effective_date.isoformat()}
        for a in identity.addresses
    ]
    current_address = address_history[-1] if address_history else None

    return {
        "id": str(identity.id),
        "full_name": decrypt_field(identity.encrypted_full_name),
        "dob": decrypt_field(identity.encrypted_dob),
        "contact_info": decrypt_field(identity.encrypted_contact_info),
        "notes": decrypt_field(identity.encrypted_notes),
        "current_address": current_address,
        "address_history": address_history,
        **build_household_summary(identity),
    }


@router.put("/{identity_id}")
def update_identity(
    identity_id: str,
    payload: IdentityUpdate,
    current_user: User = Depends(require_role(Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    """
    TEAMMEMBER only — same as create. The person must already have
    been viewed (which requires decrypt permission and is separately
    logged) to have a pre-filled form to edit in the first place, so
    this endpoint itself only re-checks role, not elevation.
    """
    identity = db.query(Identity).filter(Identity.id == identity_id).first()
    if not identity:
        raise HTTPException(status_code=404, detail="Identity not found")

    identity.encrypted_full_name = encrypt_field(payload.full_name)
    identity.encrypted_dob = encrypt_field(payload.dob)
    identity.encrypted_contact_info = encrypt_field(payload.contact_info)
    identity.encrypted_notes = encrypt_field(payload.notes)
    identity.search_hash = blind_index(payload.full_name)
    db.commit()

    log_audit_event(db, current_user.id, "identity_updated", resource_type="identity", resource_id=identity.id)

    return {"message": "Identity updated"}


@router.get("/{identity_id}/logs")
def get_identity_logs(
    identity_id: str,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    """
    The full audit trail for this person: identity-level events
    (created, viewed, edited, moved, denied) AND every event on any
    activity that belongs to them (created, updated) — since those
    log under the activity's own resource_id, not the identity's, and
    would otherwise never surface here. This is metadata about staff
    actions, not the person's PII itself, so it's available to ADMIN
    without requiring elevation.
    """
    identity = db.query(Identity).filter(Identity.id == identity_id).first()
    if not identity:
        raise HTTPException(status_code=404, detail="Identity not found")

    activity_ids = [
        str(a_id) for (a_id,) in
        db.query(ActivityRecord.id).filter(ActivityRecord.identity_id == identity_id).all()
    ]

    conditions = [(AuditLog.resource_type == "identity") & (AuditLog.resource_id == identity_id)]
    if activity_ids:
        conditions.append((AuditLog.resource_type == "activity_record") & (AuditLog.resource_id.in_(activity_ids)))

    rows = (
        db.query(AuditLog, User.email)
        .outerjoin(User, AuditLog.user_id == User.id)
        .filter(or_(*conditions))
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


class HouseholdMemberCreate(BaseModel):
    member_type: str  # "child" | "adult"
    name: str
    age: int | None = None
    relationship: str | None = None


@router.post("/{identity_id}/household")
def add_household_member(
    identity_id: str,
    payload: HouseholdMemberCreate,
    current_user: User = Depends(require_role(Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    if payload.member_type not in ("child", "adult"):
        raise HTTPException(status_code=400, detail="member_type must be 'child' or 'adult'")

    identity = db.query(Identity).filter(Identity.id == identity_id).first()
    if not identity:
        raise HTTPException(status_code=404, detail="Identity not found")

    member = HouseholdMember(
        identity_id=identity.id,
        member_type=payload.member_type,
        encrypted_name=encrypt_field(payload.name),
        age=payload.age,
        encrypted_relationship=encrypt_field(payload.relationship) if payload.relationship else None,
    )
    db.add(member)
    db.commit()

    log_audit_event(
        db, current_user.id, "household_member_added",
        resource_type="identity", resource_id=identity.id, details=f"member_type={payload.member_type}",
    )

    return {"id": str(member.id), "message": "Household member added"}


@router.delete("/{identity_id}/household/{member_id}")
def remove_household_member(
    identity_id: str,
    member_id: str,
    current_user: User = Depends(require_role(Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    member = (
        db.query(HouseholdMember)
        .filter(HouseholdMember.id == member_id, HouseholdMember.identity_id == identity_id)
        .first()
    )
    if not member:
        raise HTTPException(status_code=404, detail="Household member not found")

    db.delete(member)
    db.commit()

    log_audit_event(
        db, current_user.id, "household_member_removed",
        resource_type="identity", resource_id=identity_id,
    )

    return {"message": "Household member removed"}
