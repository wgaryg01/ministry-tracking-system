from datetime import date as date_type

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Role, Identity, Address, AuditLog, ActivityRecord, HouseholdMember, AssistanceRequest
from app.permissions import require_role, can_decrypt_pii, log_pii_access
from app.crypto import encrypt_field, decrypt_field, blind_index, encode_checklist, decode_checklist
from app.audit import log_audit_event
from app.household import build_household_summary

router = APIRouter(prefix="/identities", tags=["identities"])


class AddressCreate(BaseModel):
    street: str
    unit: str | None = None
    city: str
    state: str
    zip: str


class IdentityCreate(BaseModel):
    # Applicant Info
    first_name: str
    last_name: str
    phone: str
    email: str | None = None
    notes: str | None = None
    address: AddressCreate

    # Employment Info
    employment_status: list[str]  # e.g. ["full_time", "unable_to_work", "other"]
    employment_status_other: str | None = None
    employer_name: str | None = None
    job_title: str | None = None

    # How did you hear about us
    referral_source: list[str] | None = None
    referral_source_other: str | None = None
    referral_name: str | None = None


class IdentityUpdate(BaseModel):
    first_name: str
    last_name: str
    phone: str
    email: str | None = None
    notes: str | None = None
    employment_status: list[str]
    employment_status_other: str | None = None
    employer_name: str | None = None
    job_title: str | None = None
    referral_source: list[str] | None = None
    referral_source_other: str | None = None
    referral_name: str | None = None
    # Address is deliberately excluded — moves are recorded via
    # POST /identities/{id}/addresses, never overwritten here.


class AddressUpdate(BaseModel):
    street: str
    unit: str | None = None
    city: str
    state: str
    zip: str
    effective_date: date_type | None = None  # defaults to today — the date the move took effect


class HouseholdMemberCreate(BaseModel):
    member_type: str  # "child" | "adult"
    name: str
    age: int | None = None
    relationship: str | None = None


def _address_out(a: Address) -> dict:
    return {
        "street": decrypt_field(a.encrypted_street),
        "unit": decrypt_field(a.encrypted_unit),
        "city": decrypt_field(a.encrypted_city),
        "state": decrypt_field(a.encrypted_state),
        "zip": decrypt_field(a.encrypted_zip),
        "effective_date": a.effective_date.isoformat(),
    }


@router.post("")
def create_identity(
    payload: IdentityCreate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    identity = Identity(
        encrypted_first_name=encrypt_field(payload.first_name),
        encrypted_last_name=encrypt_field(payload.last_name),
        encrypted_phone=encrypt_field(payload.phone),
        encrypted_email=encrypt_field(payload.email),
        encrypted_notes=encrypt_field(payload.notes),
        encrypted_employment_status=encrypt_field(encode_checklist(payload.employment_status, payload.employment_status_other)),
        encrypted_employer_name=encrypt_field(payload.employer_name),
        encrypted_job_title=encrypt_field(payload.job_title),
        encrypted_referral_source=encrypt_field(encode_checklist(payload.referral_source or [], payload.referral_source_other)),
        encrypted_referral_name=encrypt_field(payload.referral_name),
        search_hash=blind_index(f"{payload.last_name}|{payload.first_name}".lower()),
    )
    db.add(identity)
    db.commit()
    db.refresh(identity)

    address_row = Address(
        identity_id=identity.id,
        encrypted_street=encrypt_field(payload.address.street),
        encrypted_unit=encrypt_field(payload.address.unit),
        encrypted_city=encrypt_field(payload.address.city),
        encrypted_state=encrypt_field(payload.address.state),
        encrypted_zip=encrypt_field(payload.address.zip),
        effective_date=date_type.today(),
    )
    db.add(address_row)
    db.commit()

    log_audit_event(db, current_user.id, "identity_created", resource_type="identity", resource_id=identity.id)

    return {"id": str(identity.id), "message": "Identity created"}


@router.put("/{identity_id}")
def update_identity(
    identity_id: str,
    payload: IdentityUpdate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    identity = db.query(Identity).filter(Identity.id == identity_id).first()
    if not identity:
        raise HTTPException(status_code=404, detail="Identity not found")

    identity.encrypted_first_name = encrypt_field(payload.first_name)
    identity.encrypted_last_name = encrypt_field(payload.last_name)
    identity.encrypted_phone = encrypt_field(payload.phone)
    identity.encrypted_email = encrypt_field(payload.email)
    identity.encrypted_notes = encrypt_field(payload.notes)
    identity.encrypted_employment_status = encrypt_field(encode_checklist(payload.employment_status, payload.employment_status_other))
    identity.encrypted_employer_name = encrypt_field(payload.employer_name)
    identity.encrypted_job_title = encrypt_field(payload.job_title)
    identity.encrypted_referral_source = encrypt_field(encode_checklist(payload.referral_source or [], payload.referral_source_other))
    identity.encrypted_referral_name = encrypt_field(payload.referral_name)
    identity.search_hash = blind_index(f"{payload.last_name}|{payload.first_name}".lower())
    db.commit()

    log_audit_event(db, current_user.id, "identity_updated", resource_type="identity", resource_id=identity.id)

    return {"message": "Identity updated"}


@router.post("/{identity_id}/addresses")
def record_address_change(
    identity_id: str,
    payload: AddressUpdate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    """Records a move. Never overwrites a prior address — each call adds a new row."""
    identity = db.query(Identity).filter(Identity.id == identity_id).first()
    if not identity:
        raise HTTPException(status_code=404, detail="Identity not found")

    address_row = Address(
        identity_id=identity.id,
        encrypted_street=encrypt_field(payload.street),
        encrypted_unit=encrypt_field(payload.unit),
        encrypted_city=encrypt_field(payload.city),
        encrypted_state=encrypt_field(payload.state),
        encrypted_zip=encrypt_field(payload.zip),
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


@router.post("/{identity_id}/household")
def add_household_member(
    identity_id: str,
    payload: HouseholdMemberCreate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
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
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
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

    log_audit_event(db, current_user.id, "household_member_removed", resource_type="identity", resource_id=identity_id)

    return {"message": "Household member removed"}


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

    address_history = [_address_out(a) for a in identity.addresses]
    current_address = address_history[-1] if address_history else None

    return {
        "id": str(identity.id),
        "first_name": decrypt_field(identity.encrypted_first_name),
        "last_name": decrypt_field(identity.encrypted_last_name),
        "phone": decrypt_field(identity.encrypted_phone),
        "email": decrypt_field(identity.encrypted_email),
        "notes": decrypt_field(identity.encrypted_notes),
        "employment_status": decode_checklist(decrypt_field(identity.encrypted_employment_status)),
        "employer_name": decrypt_field(identity.encrypted_employer_name),
        "job_title": decrypt_field(identity.encrypted_job_title),
        "referral_source": decode_checklist(decrypt_field(identity.encrypted_referral_source)),
        "referral_name": decrypt_field(identity.encrypted_referral_name),
        "current_address": current_address,
        "address_history": address_history,
        **build_household_summary(identity),
    }


@router.get("/{identity_id}/logs")
def get_identity_logs(
    identity_id: str,
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER)),
    db: Session = Depends(get_db),
):
    """
    The full audit trail for this person: identity-level events, plus
    every event on any request or activity that belongs to them (those
    log under the request/activity's own resource_id, not the
    identity's, and would otherwise never surface here).
    """
    identity = db.query(Identity).filter(Identity.id == identity_id).first()
    if not identity:
        raise HTTPException(status_code=404, detail="Identity not found")

    request_ids = [
        str(r_id) for (r_id,) in
        db.query(AssistanceRequest.id).filter(AssistanceRequest.identity_id == identity_id).all()
    ]
    activity_ids = []
    if request_ids:
        activity_ids = [
            str(a_id) for (a_id,) in
            db.query(ActivityRecord.id).filter(ActivityRecord.assistance_request_id.in_(request_ids)).all()
        ]

    conditions = [(AuditLog.resource_type == "identity") & (AuditLog.resource_id == identity_id)]
    if request_ids:
        conditions.append((AuditLog.resource_type == "assistance_request") & (AuditLog.resource_id.in_(request_ids)))
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
