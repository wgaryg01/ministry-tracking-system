from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException, Response
from sqlalchemy.orm import Session
import json
import re

from app.db import get_db
from app.models import User, Role, OrgSettings
from app.upload_utils import read_upload_limited
from app.permissions import require_role
from app.audit import log_audit_event
from app.config import settings

router = APIRouter(prefix="/org", tags=["org"])

ALLOWED_LOGO_TYPES = {"image/png", "image/jpeg", "image/svg+xml", "image/webp"}
MAX_LOGO_BYTES = 2 * 1024 * 1024  # 2MB

# Whitelisted CSS variable names — these get inserted directly into
# the page's inline styles, so only known variables with values that
# look like real hex colors are ever accepted.
ALLOWED_THEME_VARS = {
    "--ink", "--ink-soft", "--paper", "--paper-raised",
    "--brass", "--brass-deep", "--slate", "--slate-deep", "--line",
}
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")


def _parse_theme_colors(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(status_code=400, detail="theme_colors must be valid JSON")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="theme_colors must be a JSON object")

    cleaned = {}
    for key, value in data.items():
        if key not in ALLOWED_THEME_VARS:
            raise HTTPException(status_code=400, detail=f"Unknown theme variable: {key}")
        if not isinstance(value, str) or not HEX_COLOR_RE.match(value):
            raise HTTPException(status_code=400, detail=f"Invalid color value for {key}: must be a hex color")
        cleaned[key] = value
    return cleaned


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
        "environment": settings.environment,
        "theme_colors": _parse_theme_colors(settings_row.theme_colors),
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
    theme_colors: str = Form(None),
    logo: UploadFile = File(None),
    current_user: User = Depends(require_role(Role.ADMIN)),
    db: Session = Depends(get_db),
):
    settings_row = _get_or_create_settings(db)
    changes = []

    if ministry_name is not None and ministry_name.strip():
        settings_row.ministry_name = ministry_name.strip()
        changes.append("ministry_name")

    if theme_colors is not None:
        cleaned = _parse_theme_colors(theme_colors)
        settings_row.theme_colors = json.dumps(cleaned) if cleaned else None
        changes.append("theme_colors")

    if logo is not None:
        if logo.content_type not in ALLOWED_LOGO_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"Logo must be one of: {', '.join(ALLOWED_LOGO_TYPES)}",
            )
        data = await read_upload_limited(logo, MAX_LOGO_BYTES)
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
