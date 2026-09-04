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
    Returns True if the user can decrypt PII unconditionally (TEAMMEMBER),
    the active ElevationGrant if an ADMIN is currently elevated, or False
    if decryption isn't permitted right now (VOLUNTEER, or ADMIN with no
    active elevation).
    """
    if user.role == Role.TEAMMEMBER:
        return True
    if user.role == Role.ADMIN:
        grant = get_active_elevation(user, db)
        return grant if grant else False
    return False


def log_pii_access(db: Session, user: User, identity_id, elevation_grant: ElevationGrant | None = None) -> None:
    entry = PiiAccessLog(
        user_id=user.id,
        identity_id=identity_id,
        via_elevation=str(elevation_grant.id) if elevation_grant else None,
    )
    db.add(entry)
    db.commit()
