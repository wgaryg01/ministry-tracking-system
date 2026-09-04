from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Role, ElevationGrant
from app.permissions import require_role, get_active_elevation
from app.audit import log_audit_event

router = APIRouter(prefix="/elevation", tags=["elevation"])

MAX_ELEVATION_MINUTES = 60


class ElevationRequest(BaseModel):
    reason: str = Field(min_length=5, max_length=500)
    duration_minutes: int = Field(default=15, ge=1, le=MAX_ELEVATION_MINUTES)


@router.post("/request")
def request_elevation(
    payload: ElevationRequest,
    current_user: User = Depends(require_role(Role.ADMIN)),
    db: Session = Depends(get_db),
):
    """
    Grants the requesting ADMIN temporary PII-decrypt access. Every grant
    requires a stated reason and is capped at 60 minutes. TEAMMEMBER users
    never need this — they can already decrypt. This does not apply to
    VOLUNTEER, who cannot request elevation at all.
    """
    existing = get_active_elevation(current_user, db)
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Already elevated until {existing.expires_at.isoformat()}",
        )

    grant = ElevationGrant(
        user_id=current_user.id,
        reason=payload.reason,
        expires_at=datetime.utcnow() + timedelta(minutes=payload.duration_minutes),
    )
    db.add(grant)
    db.commit()
    db.refresh(grant)

    log_audit_event(
        db, current_user.id, "elevation_requested",
        resource_type="elevation_grant", resource_id=grant.id,
        details=f"reason={payload.reason} duration_minutes={payload.duration_minutes}",
    )

    return {
        "message": "Elevation granted",
        "expires_at": grant.expires_at.isoformat(),
        "reason": grant.reason,
    }


@router.post("/revoke")
def revoke_elevation(
    current_user: User = Depends(require_role(Role.ADMIN)),
    db: Session = Depends(get_db),
):
    """Lets an elevated ADMIN end their own elevation early."""
    grant = get_active_elevation(current_user, db)
    if not grant:
        raise HTTPException(status_code=400, detail="No active elevation to revoke")

    grant.revoked_at = datetime.utcnow()
    db.commit()
    log_audit_event(db, current_user.id, "elevation_revoked", resource_type="elevation_grant", resource_id=grant.id)
    return {"message": "Elevation revoked"}


@router.get("/status")
def elevation_status(
    current_user: User = Depends(require_role(Role.ADMIN)),
    db: Session = Depends(get_db),
):
    grant = get_active_elevation(current_user, db)
    if not grant:
        return {"elevated": False}
    return {
        "elevated": True,
        "expires_at": grant.expires_at.isoformat(),
        "reason": grant.reason,
    }
