from sqlalchemy.orm import Session

from app.models import AuditLog


def log_audit_event(
    db: Session,
    user_id,
    action: str,
    resource_type: str | None = None,
    resource_id: str | None = None,
    details: str | None = None,
) -> None:
    entry = AuditLog(
        user_id=user_id,
        action=action,
        resource_type=resource_type,
        resource_id=str(resource_id) if resource_id else None,
        details=details,
    )
    db.add(entry)
    db.commit()
