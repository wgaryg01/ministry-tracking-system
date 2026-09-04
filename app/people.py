from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Identity, ActivityRecord, ActivityAssignment, NotificationRule
from app.auth import get_current_user
from app.permissions import can_decrypt_pii, log_pii_access
from app.crypto import decrypt_field
from app.audit import log_audit_event
from app.household import build_household_summary

router = APIRouter(prefix="/people", tags=["people"])


def _period_starts() -> tuple[date, date, date]:
    today = date.today()
    month_start = today.replace(day=1)
    quarter_start_month = ((today.month - 1) // 3) * 3 + 1
    quarter_start = today.replace(month=quarter_start_month, day=1)
    # Fiscal year starts September 1 (standard for most churches).
    fiscal_year_start_year = today.year if today.month >= 9 else today.year - 1
    year_start = date(fiscal_year_start_year, 9, 1)
    return month_start, quarter_start, year_start


@router.get("")
def list_people(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Available to every authenticated role. Names are only included if
    the requester can currently decrypt PII (TEAMMEMBER always, ADMIN
    only while elevated) — VOLUNTEER sees the same totals per person,
    identified only by identity_id, same as the old activity ledger.
    """
    month_start, quarter_start, year_start = _period_starts()
    activities = db.query(ActivityRecord).all()

    totals = defaultdict(lambda: {
        "month": 0.0, "quarter": 0.0, "year": 0.0, "all_time": 0.0,
        "count": 0, "last_activity_date": None,
    })
    for a in activities:
        t = totals[a.identity_id]
        amt = float(a.amount_spent) if a.amount_spent is not None else 0.0
        t["all_time"] += amt
        if a.activity_date >= year_start:
            t["year"] += amt
        if a.activity_date >= quarter_start:
            t["quarter"] += amt
        if a.activity_date >= month_start:
            t["month"] += amt
        t["count"] += 1
        if t["last_activity_date"] is None or a.activity_date > t["last_activity_date"]:
            t["last_activity_date"] = a.activity_date

    grant_or_true = can_decrypt_pii(current_user, db)
    can_see_names = bool(grant_or_true)
    elevation_grant = grant_or_true if grant_or_true is not True else None

    identities_by_id = {}
    if can_see_names and totals:
        rows = db.query(Identity).filter(Identity.id.in_(list(totals.keys()))).all()
        identities_by_id = {row.id: row for row in rows}

    results = []
    for identity_id, t in totals.items():
        name = None
        if can_see_names:
            identity_row = identities_by_id.get(identity_id)
            if identity_row:
                name = decrypt_field(identity_row.encrypted_full_name)
                log_pii_access(db, current_user, identity_id, elevation_grant)
        results.append({
            "identity_id": str(identity_id),
            "name": name,
            "month_total": round(t["month"], 2),
            "quarter_total": round(t["quarter"], 2),
            "year_total": round(t["year"], 2),
            "all_time_total": round(t["all_time"], 2),
            "activity_count": t["count"],
            "last_activity_date": t["last_activity_date"].isoformat() if t["last_activity_date"] else None,
        })

    results.sort(key=lambda r: r["last_activity_date"] or "", reverse=True)

    org_totals = {
        "month_total": round(sum(r["month_total"] for r in results), 2),
        "quarter_total": round(sum(r["quarter_total"] for r in results), 2),
        "year_total": round(sum(r["year_total"] for r in results), 2),
        "all_time_total": round(sum(r["all_time_total"] for r in results), 2),
    }

    log_audit_event(
        db, current_user.id, "people_list_viewed",
        resource_type="identity", details=f"count={len(results)} names_shown={can_see_names}",
    )

    return {"org_totals": org_totals, "people": results}


@router.get("/{identity_id}/activities")
def get_person_detail(
    identity_id: str,
    page: int = 1,
    page_size: int = 15,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Available to every authenticated role. VOLUNTEER gets the activity
    list (date/amount/category) but null name/address, same boundary
    as everywhere else. TEAMMEMBER and elevated ADMIN get the full
    decrypted picture, including address history. Activities are
    paginated (page_size capped at 50) since a long-served person can
    accumulate a lot of history.
    """
    page = max(page, 1)
    page_size = min(max(page_size, 1), 50)

    identity = db.query(Identity).filter(Identity.id == identity_id).first()
    if not identity:
        raise HTTPException(status_code=404, detail="Person not found")

    base_query = db.query(ActivityRecord).filter(ActivityRecord.identity_id == identity_id)
    total = base_query.count()
    activities = (
        base_query
        .order_by(ActivityRecord.activity_date.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    grant_or_true = can_decrypt_pii(current_user, db)
    can_see_pii = bool(grant_or_true)
    can_see_staffing = current_user.role != "volunteer"  # assignment/notification info isn't client PII, just staff-only

    activity_list = []
    for a in activities:
        entry = {
            "id": str(a.id),
            "activity_date": a.activity_date.isoformat(),
            "amount_spent": float(a.amount_spent) if a.amount_spent is not None else None,
            "category": a.category,
            "status": a.status,
            "scheduled_at": a.scheduled_at.isoformat() if a.scheduled_at else None,
            "notes": decrypt_field(a.encrypted_notes) if can_see_pii else None,
        }
        if can_see_staffing:
            assigned = (
                db.query(User.id, User.email)
                .join(ActivityAssignment, ActivityAssignment.user_id == User.id)
                .filter(ActivityAssignment.activity_id == a.id)
                .all()
            )
            entry["assigned_to"] = [{"id": str(uid), "email": email} for uid, email in assigned]
            offsets = (
                db.query(NotificationRule.offset_minutes)
                .filter(NotificationRule.activity_id == a.id)
                .order_by(NotificationRule.offset_minutes)
                .all()
            )
            entry["notification_offsets_minutes"] = [o[0] for o in offsets]
        activity_list.append(entry)

    pagination = {"page": page, "page_size": page_size, "total": total}
    if not grant_or_true:
        log_audit_event(
            db, current_user.id, "identity_view_denied",
            resource_type="identity", resource_id=identity.id,
        )
        return {
            "identity_id": identity_id, "name": None, "dob": None,
            "contact_info": None, "notes": None,
            "current_address": None, "address_history": [],
            "household_members": [], "total_adults": None, "total_children": None, "total_household": None,
            "activities": activity_list, "pagination": pagination,
        }

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
        "identity_id": identity_id,
        "name": decrypt_field(identity.encrypted_full_name),
        "dob": decrypt_field(identity.encrypted_dob),
        "contact_info": decrypt_field(identity.encrypted_contact_info),
        "notes": decrypt_field(identity.encrypted_notes),
        "current_address": current_address,
        "address_history": address_history,
        **build_household_summary(identity),
        "activities": activity_list,
        "pagination": pagination,
    }
