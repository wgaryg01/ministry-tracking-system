from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException, Response
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Role, OrgSettings
from app.permissions import require_role
from app.audit import log_audit_event

router = APIRouter(prefix="/org", tags=["org"])

ALLOWED_LOGO_TYPES = {"image/png", "image/jpeg", "image/svg+xml", "image/webp"}
MAX_LOGO_BYTES = 2 * 1024 * 1024  # 2MB


def _get_or_create_settings(db: Session) -> OrgSettings:
    settings_row = db.query(OrgSettings).first()
    if not settings_row:
        settings_row = OrgSettings(ministry_name="Ministry")
        db.add(settings_row)
        db.commit()
        db.refresh(settings_row)
    return settings_row


@router.get("/settings")
def get_org_settings(db: Session = Depends(get_db)):
    """
    Public — no auth required. The sign-in page needs the ministry
    name/logo before anyone has signed in.
    """
    settings_row = _get_or_create_settings(db)
    return {
        "ministry_name": settings_row.ministry_name,
        "has_logo": settings_row.logo_data is not None,
    }


@router.get("/logo")
def get_org_logo(db: Session = Depends(get_db)):
    settings_row = _get_or_create_settings(db)
    if not settings_row.logo_data:
        raise HTTPException(status_code=404, detail="No logo has been set")
    return Response(content=settings_row.logo_data, media_type=settings_row.logo_content_type)


@router.put("/settings")
async def update_org_settings(
    ministry_name: str = Form(None),
    logo: UploadFile = File(None),
    current_user: User = Depends(require_role(Role.ADMIN)),
    db: Session = Depends(get_db),
):
    settings_row = _get_or_create_settings(db)
    changes = []

    if ministry_name is not None and ministry_name.strip():
        settings_row.ministry_name = ministry_name.strip()
        changes.append("ministry_name")

    if logo is not None:
        if logo.content_type not in ALLOWED_LOGO_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"Logo must be one of: {', '.join(ALLOWED_LOGO_TYPES)}",
            )
        data = await logo.read()
        if len(data) > MAX_LOGO_BYTES:
            raise HTTPException(status_code=400, detail="Logo must be under 2MB")
        settings_row.logo_data = data
        settings_row.logo_content_type = logo.content_type
        changes.append("logo")

    settings_row.updated_by_user_id = current_user.id
    db.commit()

    log_audit_event(
        db, current_user.id, "org_settings_updated",
        resource_type="org_settings", details=f"changed={','.join(changes) or 'nothing'}",
    )

    return {
        "ministry_name": settings_row.ministry_name,
        "has_logo": settings_row.logo_data is not None,
        "changed": changes,
    }
