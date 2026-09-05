from datetime import datetime

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db import get_db
from app.models import User, Role, ElevationGrant, PiiAccessLog
from app.audit import log_audit_event


def require_role(*allowed_roles: Role):
    """
    Dependency factory: use as Depends(require_role(Role.ADMIN, Role.TEAMMEMBER))
    on any route that should only be reachable by specific roles. Every
    denial is written to the audit log, including the route path that
    was blocked.
    """
    def dependency(
        request: Request,
        current_user: User = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> User:
        if current_user.role not in allowed_roles:
            log_audit_event(
                db, current_user.id, "access_denied",
                resource_type="route", resource_id=None,
                details=f"path={request.url.path} role={current_user.role.value}",
            )
            raise HTTPException(status_code=403, detail="Not authorized for this action")
        return current_user
    return dependency


def get_active_elevation(user: User, db: Session) -> ElevationGrant | None:
    """Returns the user's current unexpired, unrevoked elevation grant, if any."""
    return (
        db.query(ElevationGrant)
        .filter(
            ElevationGrant.user_id == user.id,
            ElevationGrant.revoked_at.is_(None),
            ElevationGrant.expires_at > datetime.utcnow(),
        )
        .order_by(ElevationGrant.granted_at.desc())
        .first()
    )


def can_decrypt_pii(user: User, db: Session) -> ElevationGrant | bool:
    """
    ADMIN and TEAMMEMBER can both always decrypt PII — ADMIN no longer
    needs to request elevation. DEACON (the Role.VOLUNTEER value —
    kept internally to avoid another destructive rename migration,
    relabeled "Deacon" everywhere in the UI) and FINANCIAL_SECRETARY
    never can — the Financial Secretary manages the check register in
    full detail, but never sees who any of the money was for.
    """
    if user.role in (Role.TEAMMEMBER, Role.ADMIN):
        return True
    return False


def can_manage_check_register(user: User) -> bool:
    """ADMIN and FINANCIAL_SECRETARY manage the check register — nobody else."""
    return user.role in (Role.ADMIN, Role.FINANCIAL_SECRETARY)


def log_pii_access(db: Session, user: User, identity_id, elevation_grant: ElevationGrant | None = None) -> None:
    entry = PiiAccessLog(
        user_id=user.id,
        identity_id=identity_id,
        via_elevation=str(elevation_grant.id) if elevation_grant else None,
    )
    db.add(entry)
    db.commit()
