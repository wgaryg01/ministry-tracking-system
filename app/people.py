from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Identity, ActivityRecord, AssistanceRequest, RequestDocument, ActivityAssignment, NotificationRule, RequestVote
from app.auth import get_current_user
from app.permissions import can_decrypt_pii, log_pii_access
from app.crypto import decrypt_field, decode_checklist
from app.audit import log_audit_event
from app.household import build_household_summary

router = APIRouter(prefix="/people", tags=["people"])

OPEN_STATUSES = {"new", "pending_approval", "approved", "in_progress", "on_hold"}
RESOLVED_STATUSES = {"denied", "completed", "canceled"}


def _period_starts() -> tuple[date, date, date]:
    today = date.today()
    month_start = today.replace(day=1)
    quarter_start_month = ((today.month - 1) // 3) * 3 + 1
    quarter_start = today.replace(month=quarter_start_month, day=1)
    fiscal_year_start_year = today.year if today.month >= 9 else today.year - 1
    year_start = date(fiscal_year_start_year, 9, 1)
    return month_start, quarter_start, year_start


@router.get("")
def list_people(
    search: str | None = None,
    sort: str = "recent",  # "recent" | "oldest" | "first_name" | "last_name" | "amount"
    show_all: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Available to every authenticated role. Names/search are only
    available if the requester can currently decrypt PII (TEAMMEMBER
    and ADMIN always; DEACON — the Role.VOLUNTEER value — never).
    By default only shows recipients with an open request, or a
    denied/completed/canceled request within the last 30 days —
    pass show_all=true or a search term to see everyone regardless.
    """
    month_start, quarter_start, year_start = _period_starts()
    thirty_days_ago = date.today() - timedelta(days=30)

    all_identities = db.query(Identity).all()

    totals = {
        identity.id: {
            "month": 0.0, "quarter": 0.0, "year": 0.0, "all_time": 0.0,
            "count": 0, "last_activity_date": None, "created_at": identity.created_at,
        }
        for identity in all_identities
    }

    rows = (
        db.query(ActivityRecord, AssistanceRequest.identity_id)
        .join(AssistanceRequest, ActivityRecord.assistance_request_id == AssistanceRequest.id)
        .all()
    )
    for a, identity_id in rows:
        if identity_id not in totals:
            continue
        t = totals[identity_id]
        amt = float(a.amount_spent) if (a.amount_spent is not None and a.payment_approved) else 0.0
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

    # Latest request per identity — drives the Date/Status columns and
    # the default active/recent filter.
    latest_request_by_identity = {}
    for req in db.query(AssistanceRequest).all():
        req_date = req.acknowledged_date or (req.created_at.date() if req.created_at else date.min)
        existing = latest_request_by_identity.get(req.identity_id)
        if existing is None or req_date > existing["date"]:
            latest_request_by_identity[req.identity_id] = {"date": req_date, "status": req.status}

    grant_or_true = can_decrypt_pii(current_user, db)
    can_see_names = bool(grant_or_true)
    elevation_grant = grant_or_true if grant_or_true is not True else None

    identities_by_id = {identity.id: identity for identity in all_identities}

    results = []
    for identity_id, t in totals.items():
        first_name = last_name = name = None
        if can_see_names:
            identity_row = identities_by_id.get(identity_id)
            if identity_row:
                first_name = decrypt_field(identity_row.encrypted_first_name)
                last_name = decrypt_field(identity_row.encrypted_last_name)
                name = f"{first_name} {last_name}"
                log_pii_access(db, current_user, identity_id, elevation_grant)

        latest_req = latest_request_by_identity.get(identity_id)
        request_date = latest_req["date"] if latest_req else None
        request_status = latest_req["status"] if latest_req else None
        is_active = bool(
            latest_req and (
                latest_req["status"] in OPEN_STATUSES
                or (latest_req["status"] in RESOLVED_STATUSES and latest_req["date"] >= thirty_days_ago)
            )
        )

        # Effective date for recency sorting: last activity if any,
        # else when the person was added — so a brand-new person with
        # no activity yet still sorts sensibly rather than always last.
        effective_date = t["last_activity_date"] or (t["created_at"].date() if t["created_at"] else None)

        results.append({
            "identity_id": str(identity_id),
            "name": name,
            "first_name": first_name,
            "last_name": last_name,
            "request_date": request_date.isoformat() if request_date else None,
            "request_status": request_status,
            "is_active": is_active,
            "month_total": round(t["month"], 2),
            "quarter_total": round(t["quarter"], 2),
            "year_total": round(t["year"], 2),
            "all_time_total": round(t["all_time"], 2),
            "activity_count": t["count"],
            "last_activity_date": t["last_activity_date"].isoformat() if t["last_activity_date"] else None,
            "_effective_date": effective_date,
        })

    if search is not None and len(search.strip()) < 4:
        raise HTTPException(status_code=400, detail="Search must be at least 4 characters")

    if search and can_see_names:
        needle = search.strip().lower()
        results = [
            r for r in results
            if needle in (r["first_name"] or "").lower()
            or needle in (r["last_name"] or "").lower()
            or needle in f"{r['first_name'] or ''} {r['last_name'] or ''}".lower()
            or needle in f"{r['last_name'] or ''} {r['first_name'] or ''}".lower()
            or needle in f"{r['last_name'] or ''}, {r['first_name'] or ''}".lower()
        ]
    elif not show_all:
        # No search — apply the default active/recent filter.
        results = [r for r in results if r["is_active"]]

    if sort == "oldest":
        results.sort(key=lambda r: r["_effective_date"] or date.min)
    elif sort == "amount":
        results.sort(key=lambda r: r["all_time_total"], reverse=True)
    elif sort == "first_name" and can_see_names:
        results.sort(key=lambda r: (r["first_name"] or "").lower())
    elif sort == "last_name" and can_see_names:
        results.sort(key=lambda r: ((r["last_name"] or "").lower(), (r["first_name"] or "").lower()))
    else:  # "recent" default, and the fallback when a name-sort was requested but names aren't visible
        results.sort(key=lambda r: r["_effective_date"] or date.min, reverse=True)

    for r in results:
        del r["_effective_date"]

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


def _activity_out(a: ActivityRecord, can_see_pii: bool) -> dict:
    out = {
        "id": str(a.id),
        "activity_date": a.activity_date.isoformat(),
        "amount_spent": float(a.amount_spent) if a.amount_spent is not None else None,
        "category": a.category,
        "payee_name": a.payee_name,
        "status": a.status,
        "scheduled_at": a.scheduled_at.isoformat() if a.scheduled_at else None,
        "payment_approved": a.payment_approved,
        "notes": decrypt_field(a.encrypted_notes) if can_see_pii else None,
    }
    if can_see_pii:
        out["attachments"] = [
            {"id": str(att.id), "filename": att.filename, "content_type": att.content_type}
            for att in a.attachments
        ]
    else:
        out["attachment_count"] = len(a.attachments)
    return out


VALID_PER_PAGE = {10, 20, 50, 100}
ALL_REQUEST_STATUSES = OPEN_STATUSES | RESOLVED_STATUSES


@router.get("/roster")
def list_recipient_roster(
    page: int = 1,
    per_page: int = 20,
    request_status: str | None = None,   # a specific status, e.g. "on_hold"
    request_scope: str | None = None,    # "open" | "closed" | None (everyone)
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Every recipient, regardless of whether they have any requests yet
    (a teammember may have been interrupted mid-intake) — paginated,
    with a request count and total received per person. Replaces the
    old separate Open/Closed Requests pages: request_scope covers
    that same need as a filter here instead of a separate page.
    """
    if per_page not in VALID_PER_PAGE:
        per_page = 20
    if page < 1:
        page = 1
    if request_status and request_status not in ALL_REQUEST_STATUSES:
        raise HTTPException(status_code=400, detail=f"request_status must be one of: {', '.join(sorted(ALL_REQUEST_STATUSES))}")
    if request_scope and request_scope not in ("open", "closed"):
        raise HTTPException(status_code=400, detail="request_scope must be 'open' or 'closed'")

    can_see_names = bool(can_decrypt_pii(current_user, db))

    all_identities = db.query(Identity).order_by(Identity.created_at.desc()).all()
    all_requests = db.query(AssistanceRequest).all()
    all_activities = db.query(ActivityRecord).all()

    requests_by_identity: dict = {}
    for req in all_requests:
        requests_by_identity.setdefault(req.identity_id, []).append(req)

    approved_amount_by_request: dict = {}
    for a in all_activities:
        if a.amount_spent is not None and a.payment_approved:
            approved_amount_by_request[a.assistance_request_id] = (
                approved_amount_by_request.get(a.assistance_request_id, 0.0) + float(a.amount_spent)
            )

    results = []
    for identity in all_identities:
        reqs = requests_by_identity.get(identity.id, [])

        if request_status and not any(r.status == request_status for r in reqs):
            continue
        if request_scope == "open" and not any(r.status in OPEN_STATUSES for r in reqs):
            continue
        if request_scope == "closed" and not any(r.status in RESOLVED_STATUSES for r in reqs):
            continue

        name = None
        if can_see_names:
            name = f"{decrypt_field(identity.encrypted_first_name)} {decrypt_field(identity.encrypted_last_name)}"
            log_pii_access(db, current_user, identity.id, None)

        total_received = round(sum(approved_amount_by_request.get(r.id, 0.0) for r in reqs), 2)

        results.append({
            "identity_id": str(identity.id),
            "name": name,
            "request_count": len(reqs),
            "total_received": total_received,
        })

    total_count = len(results)
    start = (page - 1) * per_page
    page_results = results[start:start + per_page]

    log_audit_event(
        db, current_user.id, "recipient_roster_listed",
        resource_type="identity", details=f"page={page} per_page={per_page} count={len(page_results)}",
    )

    return {
        "people": page_results,
        "total_count": total_count,
        "page": page,
        "per_page": per_page,
        "total_pages": max(1, (total_count + per_page - 1) // per_page),
    }

@router.get("/{identity_id}")
def get_person(
    identity_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    The full picture for one person: identity/applicant info (gated),
    address, household, and every assistance request with its
    activities and documents nested underneath. VOLUNTEER (and a
    non-elevated ADMIN) get null identity fields and request details,
    but still see each request's activity dates/amounts/categories —
    same PII boundary as everywhere else, just one level deeper now.
    """
    identity = db.query(Identity).filter(Identity.id == identity_id).first()
    if not identity:
        raise HTTPException(status_code=404, detail="Person not found")

    # One batched lookup for "last edited by" names, rather than a
    # query per record — attribution isn't recipient PII (it's who on
    # the team touched it), so it's shown regardless of PII access.
    user_names = {u.id: (u.full_name or u.email or u.username) for u in db.query(User).all()}

    grant_or_true = can_decrypt_pii(current_user, db)
    can_see_pii = bool(grant_or_true)
    elevation_grant = grant_or_true if grant_or_true is not True else None

    if can_see_pii:
        log_pii_access(db, current_user, identity.id, elevation_grant)
        log_audit_event(
            db, current_user.id, "identity_viewed",
            resource_type="identity", resource_id=identity.id,
            details="via_elevation" if elevation_grant else "via_teammember_role",
        )
    else:
        log_audit_event(db, current_user.id, "identity_view_denied", resource_type="identity", resource_id=identity.id)

    if can_see_pii:
        address_history = [
            {
                "street": decrypt_field(a.encrypted_street),
                "unit": decrypt_field(a.encrypted_unit),
                "city": decrypt_field(a.encrypted_city),
                "state": decrypt_field(a.encrypted_state),
                "zip": decrypt_field(a.encrypted_zip),
                "effective_date": a.effective_date.isoformat(),
            }
            for a in identity.addresses
        ]
        current_address = address_history[-1] if address_history else None
        identity_out = {
            "name": f"{decrypt_field(identity.encrypted_first_name)} {decrypt_field(identity.encrypted_last_name)}",
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
    else:
        identity_out = {
            "name": None, "first_name": None, "last_name": None, "phone": None, "email": None, "notes": None,
            "employment_status": [], "employer_name": None, "job_title": None,
            "referral_source": [], "referral_name": None,
            "current_address": None, "address_history": [],
            "household_members": [], "total_adults": None, "total_children": None, "total_household": None,
        }

    requests_out = []
    for req in db.query(AssistanceRequest).filter(AssistanceRequest.identity_id == identity_id).order_by(AssistanceRequest.created_at.desc()).all():
        activities = (
            db.query(ActivityRecord)
            .filter(ActivityRecord.assistance_request_id == req.id)
            .order_by(ActivityRecord.activity_date.desc())
            .all()
        )
        activity_list = [_activity_out(a, can_see_pii) for a in activities]
        total_amount = round(sum(float(a.amount_spent) for a in activities if a.amount_spent is not None and a.payment_approved), 2)

        votes = db.query(RequestVote).filter(RequestVote.assistance_request_id == req.id).all()
        yes_votes = sum(1 for v in votes if v.support)
        no_votes = sum(1 for v in votes if not v.support)
        my_vote_row = next((v for v in votes if v.user_id == current_user.id), None)

        voters = []
        if votes:
            voter_users = {u.id: u for u in db.query(User).filter(User.id.in_([v.user_id for v in votes])).all()}
            for v in votes:
                voter = voter_users.get(v.user_id)
                label = (voter.full_name or voter.email or voter.username) if voter else "Unknown"
                voters.append({"name": label, "support": v.support})

        vote_summary = {
            "yes": yes_votes,
            "no": no_votes,
            "my_vote": my_vote_row.support if my_vote_row else None,
            "voters": voters,
        }

        if can_see_pii:
            documents = db.query(RequestDocument).filter(RequestDocument.assistance_request_id == req.id).all()
            req_out = {
                "id": str(req.id),
                "assistance_type": decrypt_field(req.encrypted_assistance_type),
                "status": req.status,
                "payment_method": req.payment_method,
                "total_amount": total_amount,
                "votes": vote_summary,
                "situation_description": decrypt_field(req.encrypted_situation_description),
                "request_received_date": req.acknowledged_date.isoformat() if req.acknowledged_date else (req.created_at.date().isoformat() if req.created_at else None),
                "helper_name": decrypt_field(req.encrypted_helper_name),
                "helper_contact": decrypt_field(req.encrypted_helper_contact),
                "helper_relationship": decrypt_field(req.encrypted_helper_relationship),
                "created_at": req.created_at.isoformat() if req.created_at else None,
                "documents": [{"id": str(d.id), "filename": d.filename, "content_type": d.content_type} for d in documents],
                "activities": activity_list,
            }
        else:
            req_out = {
                "id": str(req.id),
                "assistance_type": None, "situation_description": None,
                "status": req.status,
                "payment_method": req.payment_method,
                "total_amount": total_amount,
                "votes": vote_summary,
                "request_received_date": req.acknowledged_date.isoformat() if req.acknowledged_date else (req.created_at.date().isoformat() if req.created_at else None),
                "helper_name": None, "helper_contact": None, "helper_relationship": None,
                "created_at": req.created_at.isoformat() if req.created_at else None,
                "documents": [],
                "activities": activity_list,
            }
        requests_out.append(req_out)

    return {"identity_id": identity_id, **identity_out, "requests": requests_out}


