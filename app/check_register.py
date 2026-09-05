from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Role, CheckRegisterEntry, CheckRegisterStartingBalance, FiscalYearBudget
from app.auth import get_current_user
from app.permissions import require_role
from app.audit import log_audit_event

router = APIRouter(prefix="/check-register", tags=["check-register"])


def fiscal_year_of(d: date) -> int:
    """Fiscal year runs Sept 1 - Aug 31, labeled by the year it ends in — same convention as reports.py."""
    return d.year + 1 if d.month >= 9 else d.year


def _replay_ledger(db: Session) -> dict:
    """
    The whole check register, recomputed from scratch every time by
    replaying income and paid expenses in date order — rather than
    storing a running balance that could drift out of sync if an
    entry is ever corrected. Fine at this transaction volume.

    Each paid expense draws from the designated-fund balance first;
    once that's exhausted, the remainder draws from that expense's
    fiscal year's annual budget instead — this is the "waterfall"
    the checkbook-plus-budget-overflow design calls for.
    """
    starting = db.query(CheckRegisterStartingBalance).order_by(CheckRegisterStartingBalance.created_at.desc()).first()
    starting_balance = float(starting.balance) if starting else 0.0
    starting_date = starting.as_of_date if starting else None

    budgets = {b.fiscal_year: float(b.budget_amount) for b in db.query(FiscalYearBudget).all()}

    income_entries = db.query(CheckRegisterEntry).filter(CheckRegisterEntry.entry_type == "income").all()
    paid_expenses = (
        db.query(CheckRegisterEntry)
        .filter(CheckRegisterEntry.entry_type == "expense", CheckRegisterEntry.status == "paid")
        .all()
    )
    pending_expenses = (
        db.query(CheckRegisterEntry)
        .filter(CheckRegisterEntry.entry_type == "expense", CheckRegisterEntry.status == "pending")
        .order_by(CheckRegisterEntry.transaction_date)
        .all()
    )

    events = [{"date": e.transaction_date, "type": "income", "entry": e} for e in income_entries]
    events += [{"date": e.date_paid, "type": "expense", "entry": e} for e in paid_expenses]
    events.sort(key=lambda x: (x["date"], x["entry"].created_at))

    designated_balance = starting_balance
    budget_used: dict[int, float] = {}
    transactions = []

    for ev in events:
        e = ev["entry"]
        amount = float(e.amount)
        if ev["type"] == "income":
            designated_balance = round(designated_balance + amount, 2)
            transactions.append({
                "id": str(e.id), "type": "income", "date": e.transaction_date.isoformat(),
                "amount": amount, "category": None, "check_number": None,
                "running_balance": designated_balance, "from_budget": 0.0,
            })
        else:
            fy = fiscal_year_of(e.date_paid)
            from_designated = min(max(designated_balance, 0.0), amount)
            from_budget = round(amount - from_designated, 2)
            designated_balance = round(designated_balance - from_designated, 2)
            if from_budget > 0:
                budget_used[fy] = round(budget_used.get(fy, 0.0) + from_budget, 2)
            transactions.append({
                "id": str(e.id), "type": "expense", "date": e.date_paid.isoformat(),
                "amount": amount, "category": e.category, "check_number": e.check_number,
                "running_balance": designated_balance, "from_budget": from_budget,
            })

    return {
        "starting_balance": round(starting_balance, 2),
        "starting_date": starting_date.isoformat() if starting_date else None,
        "designated_balance": round(designated_balance, 2),
        "fiscal_year_budgets": budgets,
        "fiscal_year_budget_used": budget_used,
        "transactions": transactions,
        "pending_expenses": [
            {
                "id": str(e.id), "date": e.transaction_date.isoformat(),
                "amount": float(e.amount), "category": e.category,
            }
            for e in pending_expenses
        ],
    }


def _period_income_expense(db: Session, start: date, end: date) -> dict:
    """Paid-only totals for a date range, used by the summary endpoint (YTD / last fiscal year)."""
    income = (
        db.query(CheckRegisterEntry)
        .filter(CheckRegisterEntry.entry_type == "income", CheckRegisterEntry.transaction_date >= start, CheckRegisterEntry.transaction_date <= end)
        .all()
    )
    expenses = (
        db.query(CheckRegisterEntry)
        .filter(CheckRegisterEntry.entry_type == "expense", CheckRegisterEntry.status == "paid", CheckRegisterEntry.date_paid >= start, CheckRegisterEntry.date_paid <= end)
        .all()
    )
    return {
        "income": round(sum(float(e.amount) for e in income), 2),
        "expenses": round(sum(float(e.amount) for e in expenses), 2),
    }


@router.get("/summary")
def get_summary(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Fund balance plus YTD/last-fiscal-year income & expense totals —
    no per-transaction detail. Available to every role, including
    Deacons, per how this was specced: everyone gets the balance and
    the high-level totals, nobody outside teammember/admin/financial
    secretary gets to see the comings and goings.
    """
    ledger = _replay_ledger(db)
    today = date.today()
    fy = fiscal_year_of(today)
    fy_start = date(fy - 1, 9, 1)
    last_fy_start = date(fy - 2, 9, 1)
    last_fy_end = date(fy - 1, 8, 31)

    return {
        "designated_balance": ledger["designated_balance"],
        "current_fiscal_year": fy,
        "current_fiscal_year_budget": ledger["fiscal_year_budgets"].get(fy, 0.0),
        "current_fiscal_year_budget_used": ledger["fiscal_year_budget_used"].get(fy, 0.0),
        "ytd": _period_income_expense(db, fy_start, today),
        "last_fiscal_year": _period_income_expense(db, last_fy_start, last_fy_end),
    }


@router.get("")
def get_full_register(
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER, Role.FINANCIAL_SECRETARY)),
    db: Session = Depends(get_db),
):
    """Full transaction-level detail — never shown to Deacons."""
    return _replay_ledger(db)


class IncomeCreate(BaseModel):
    transaction_date: date
    amount: float


@router.post("/income")
def add_income(
    payload: IncomeCreate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.FINANCIAL_SECRETARY)),
    db: Session = Depends(get_db),
):
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be positive")

    entry = CheckRegisterEntry(
        entry_type="income",
        amount=payload.amount,
        transaction_date=payload.transaction_date,
        created_by_user_id=current_user.id,
    )
    db.add(entry)
    db.commit()

    log_audit_event(
        db, current_user.id, "check_register_income_added",
        resource_type="check_register_entry", resource_id=entry.id, details=f"amount={payload.amount}",
    )

    return {"message": "Income recorded", "id": str(entry.id)}


class MarkPaidUpdate(BaseModel):
    date_paid: date
    check_number: str


@router.put("/expense/{entry_id}/pay")
def mark_expense_paid(
    entry_id: str,
    payload: MarkPaidUpdate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.FINANCIAL_SECRETARY)),
    db: Session = Depends(get_db),
):
    entry = db.query(CheckRegisterEntry).filter(CheckRegisterEntry.id == entry_id, CheckRegisterEntry.entry_type == "expense").first()
    if not entry:
        raise HTTPException(status_code=404, detail="Expense entry not found")
    if entry.status == "paid":
        raise HTTPException(status_code=400, detail="This expense is already marked paid")
    if not payload.check_number.strip():
        raise HTTPException(status_code=400, detail="Check number is required")

    entry.status = "paid"
    entry.date_paid = payload.date_paid
    entry.check_number = payload.check_number.strip()
    entry.paid_by_user_id = current_user.id
    db.commit()

    log_audit_event(
        db, current_user.id, "check_register_expense_paid",
        resource_type="check_register_entry", resource_id=entry.id, details=f"check_number={entry.check_number}",
    )

    return {"message": "Marked paid"}


class StartingBalanceCreate(BaseModel):
    balance: float
    as_of_date: date


@router.post("/starting-balance")
def set_starting_balance(
    payload: StartingBalanceCreate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.FINANCIAL_SECRETARY)),
    db: Session = Depends(get_db),
):
    db.add(CheckRegisterStartingBalance(
        balance=payload.balance,
        as_of_date=payload.as_of_date,
        set_by_user_id=current_user.id,
    ))
    db.commit()

    log_audit_event(
        db, current_user.id, "check_register_starting_balance_set",
        resource_type="check_register_starting_balance", details=f"balance={payload.balance}",
    )

    return {"message": "Starting balance set"}


class FiscalYearBudgetCreate(BaseModel):
    fiscal_year: int
    budget_amount: float


@router.post("/fiscal-year-budget")
def set_fiscal_year_budget(
    payload: FiscalYearBudgetCreate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.FINANCIAL_SECRETARY)),
    db: Session = Depends(get_db),
):
    existing = db.query(FiscalYearBudget).filter(FiscalYearBudget.fiscal_year == payload.fiscal_year).first()
    if existing:
        existing.budget_amount = payload.budget_amount
        existing.set_by_user_id = current_user.id
    else:
        db.add(FiscalYearBudget(
            fiscal_year=payload.fiscal_year,
            budget_amount=payload.budget_amount,
            set_by_user_id=current_user.id,
        ))
    db.commit()

    log_audit_event(
        db, current_user.id, "check_register_fy_budget_set",
        resource_type="fiscal_year_budget", details=f"fy={payload.fiscal_year} amount={payload.budget_amount}",
    )

    return {"message": "Budget set"}
