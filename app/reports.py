from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, AssistanceRequest, ActivityRecord
from app.auth import get_current_user
from app.audit import log_audit_event

router = APIRouter(prefix="/reports", tags=["reports"])

# Fiscal year runs September 1 - August 31, consistent with the rest
# of the app (see _period_starts in people.py). Labeled by the
# calendar year it ENDS in — e.g. Sept 2025-Aug 2026 is "FY2026".


def fiscal_year_of(d: date) -> int:
    return d.year + 1 if d.month >= 9 else d.year


def fiscal_year_start(fy_ending_year: int) -> date:
    return date(fy_ending_year - 1, 9, 1)


def fiscal_year_end(fy_ending_year: int) -> date:
    return date(fy_ending_year, 8, 31)


def fiscal_quarter_of(d: date) -> int:
    month_offset = (d.month - 9) % 12  # 0 = September
    return month_offset // 3 + 1


@router.get("/overview")
def overview_report(
    start_date: date | None = None,
    end_date: date | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Count of requests and sum of approved aid, broken down by month,
    with rollups by fiscal quarter and fiscal year. Aggregate
    financial/operational data only — no PII involved, so available
    to every role. Defaults to fiscal-year-to-date.
    """
    today = date.today()
    current_fy = fiscal_year_of(today)

    if start_date is None:
        start_date = fiscal_year_start(current_fy)
    if end_date is None:
        end_date = today
    if start_date > end_date:
        raise HTTPException(status_code=400, detail="start_date must be on or before end_date")

    requests_in_range = (
        db.query(AssistanceRequest)
        .filter(AssistanceRequest.acknowledged_date >= start_date, AssistanceRequest.acknowledged_date <= end_date)
        .all()
    )
    activities_in_range = (
        db.query(ActivityRecord)
        .filter(
            ActivityRecord.activity_date >= start_date,
            ActivityRecord.activity_date <= end_date,
            ActivityRecord.payment_approved.is_(True),
        )
        .all()
    )

    months: dict[str, dict] = {}
    quarters: dict[str, dict] = {}
    years: dict[str, dict] = {}

    def bucket(d: date):
        month_key = d.strftime("%Y-%m")
        fy = fiscal_year_of(d)
        quarter_key = f"FY{fy} Q{fiscal_quarter_of(d)}"
        year_key = f"FY{fy}"
        return month_key, quarter_key, year_key

    for req in requests_in_range:
        if not req.acknowledged_date:
            continue
        month_key, quarter_key, year_key = bucket(req.acknowledged_date)
        for store, key in ((months, month_key), (quarters, quarter_key), (years, year_key)):
            store.setdefault(key, {"request_count": 0, "aid_total": 0.0})
            store[key]["request_count"] += 1

    for a in activities_in_range:
        month_key, quarter_key, year_key = bucket(a.activity_date)
        amt = float(a.amount_spent) if a.amount_spent is not None else 0.0
        for store, key in ((months, month_key), (quarters, quarter_key), (years, year_key)):
            store.setdefault(key, {"request_count": 0, "aid_total": 0.0})
            store[key]["aid_total"] += amt

    def to_rows(store: dict) -> list:
        return [
            {"label": k, "request_count": v["request_count"], "aid_total": round(v["aid_total"], 2)}
            for k, v in sorted(store.items())
        ]

    log_audit_event(
        db, current_user.id, "overview_report_viewed",
        resource_type="assistance_request", details=f"range={start_date} to {end_date}",
    )

    return {
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "months": to_rows(months),
        "quarters": to_rows(quarters),
        "years": to_rows(years),
        "total_requests": len(requests_in_range),
        "total_aid": round(sum(float(a.amount_spent) for a in activities_in_range if a.amount_spent is not None), 2),
    }
