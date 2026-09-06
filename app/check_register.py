from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, Role, CheckRegisterEntry, CheckRegisterStartingBalance, FiscalYearBudget, CheckRegisterPresence
from app.auth import get_current_user
from app.permissions import require_role
from app.audit import log_audit_event

router = APIRouter(prefix="/check-register", tags=["check-register"])

PRESENCE_ACTIVE_SECONDS = 30


@router.post("/presence")
def check_register_heartbeat(
    current_user: User = Depends(require_role(Role.ADMIN, Role.TEAMMEMBER, Role.FINANCIAL_SECRETARY)),
    db: Session = Depends(get_db),
):
    """15s heartbeat while the Check Register page is open — powers the 'who's here' list."""
    presence = db.query(CheckRegisterPresence).filter(CheckRegisterPresence.user_id == current_user.id).first()
    if presence:
        presence.last_seen_at = datetime.utcnow()
    else:
        db.add(CheckRegisterPresence(user_id=current_user.id, last_seen_at=datetime.utcnow()))
    db.commit()
    return {"viewers": _current_viewers(db)}


def _current_viewers(db: Session) -> list[dict]:
    cutoff = datetime.utcnow() - timedelta(seconds=PRESENCE_ACTIVE_SECONDS)
    rows = (
        db.query(CheckRegisterPresence, User)
        .join(User, CheckRegisterPresence.user_id == User.id)
        .filter(CheckRegisterPresence.last_seen_at >= cutoff)
        .all()
    )
    return [{"name": u.full_name or u.email or u.username, "last_seen_at": p.last_seen_at.isoformat()} for p, u in rows]


def _touch_edited(db: Session, entry: CheckRegisterEntry, current_user: User) -> None:
    entry.last_edited_by_user_id = current_user.id
    entry.last_edited_at = datetime.utcnow()


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

    # One batched lookup instead of a query per row for "last edited by".
    user_names = {u.id: (u.full_name or u.email or u.username) for u in db.query(User).all()}

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
        edited_by = user_names.get(e.last_edited_by_user_id)
        edited_at = e.last_edited_at.isoformat() if e.last_edited_at else None
        if ev["type"] == "income":
            designated_balance = round(designated_balance + amount, 2)
            transactions.append({
                "id": str(e.id), "type": "income", "date": e.transaction_date.isoformat(),
                "amount": amount, "category": None, "check_number": None,
                "running_balance": designated_balance, "from_budget": 0.0,
                "last_edited_by": edited_by, "last_edited_at": edited_at,
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
                "amount": amount, "category": e.category, "payee_name": e.payee_name, "check_number": e.check_number,
                "running_balance": designated_balance, "from_budget": from_budget,
                "last_edited_by": edited_by, "last_edited_at": edited_at,
            })

    return {
        "starting_balance": round(starting_balance, 2),
        "starting_date": starting_date.isoformat() if starting_date else None,
        "designated_balance": round(designated_balance, 2),
        "fiscal_year_budgets": budgets,
        "fiscal_year_budget_used": budget_used,
        "transactions": transactions,
        "viewers": _current_viewers(db),
        "pending_expenses": [
            {
                "id": str(e.id), "date": e.transaction_date.isoformat(),
                "amount": float(e.amount), "category": e.category, "payee_name": e.payee_name,
                "last_edited_by": user_names.get(e.last_edited_by_user_id),
                "last_edited_at": e.last_edited_at.isoformat() if e.last_edited_at else None,
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


class StandaloneExpenseCreate(BaseModel):
    transaction_date: date
    amount: float
    category: str  # e.g. "bank fee", "service charge"
    payee_name: str | None = None
    already_paid: bool = True  # bank fees/auto-deductions are usually already gone by the time anyone enters them
    date_paid: date | None = None  # required if already_paid
    check_number: str | None = None  # optional — many of these (bank fees) have no check at all


@router.post("/expense")
def add_standalone_expense(
    payload: StandaloneExpenseCreate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.FINANCIAL_SECRETARY)),
    db: Session = Depends(get_db),
):
    """
    An expense with no linked activity — bank charges, service fees,
    or anything else paid straight out of the designated account
    outside the normal request/approval workflow.
    """
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be positive")
    if payload.already_paid and not payload.date_paid:
        raise HTTPException(status_code=400, detail="Date paid is required for an already-paid expense")

    entry = CheckRegisterEntry(
        entry_type="expense",
        amount=payload.amount,
        transaction_date=payload.transaction_date,
        activity_id=None,
        category=payload.category,
        payee_name=payload.payee_name,
        status="paid" if payload.already_paid else "pending",
        date_paid=payload.date_paid if payload.already_paid else None,
        check_number=(payload.check_number.strip() or None) if payload.already_paid and payload.check_number else None,
        created_by_user_id=current_user.id,
        paid_by_user_id=current_user.id if payload.already_paid else None,
        last_edited_by_user_id=current_user.id,
        last_edited_at=datetime.utcnow(),
    )
    db.add(entry)
    db.commit()

    log_audit_event(
        db, current_user.id, "check_register_standalone_expense_added",
        resource_type="check_register_entry", resource_id=entry.id,
        details=f"amount={payload.amount} category={payload.category} already_paid={payload.already_paid}",
    )

    return {"message": "Expense recorded", "id": str(entry.id)}


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
        last_edited_by_user_id=current_user.id,
        last_edited_at=datetime.utcnow(),
    )
    db.add(entry)
    db.commit()

    log_audit_event(
        db, current_user.id, "check_register_income_added",
        resource_type="check_register_entry", resource_id=entry.id, details=f"amount={payload.amount}",
    )

    return {"message": "Income recorded", "id": str(entry.id)}


class IncomeUpdate(BaseModel):
    transaction_date: date
    amount: float


@router.put("/income/{entry_id}")
def update_income(
    entry_id: str,
    payload: IncomeUpdate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.FINANCIAL_SECRETARY)),
    db: Session = Depends(get_db),
):
    entry = db.query(CheckRegisterEntry).filter(CheckRegisterEntry.id == entry_id, CheckRegisterEntry.entry_type == "income").first()
    if not entry:
        raise HTTPException(status_code=404, detail="Income entry not found")
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be positive")

    old = f"date={entry.transaction_date} amount={entry.amount}"
    entry.transaction_date = payload.transaction_date
    entry.amount = payload.amount
    _touch_edited(db, entry, current_user)
    db.commit()

    log_audit_event(
        db, current_user.id, "check_register_income_edited",
        resource_type="check_register_entry", resource_id=entry.id,
        details=f"{old} -> date={entry.transaction_date} amount={entry.amount}",
    )

    return {"message": "Income updated"}


class ExpenseEntryUpdate(BaseModel):
    amount: float
    category: str | None = None
    payee_name: str | None = None
    date_paid: date | None = None
    check_number: str | None = None


@router.put("/expense/{entry_id}")
def update_expense(
    entry_id: str,
    payload: ExpenseEntryUpdate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.FINANCIAL_SECRETARY)),
    db: Session = Depends(get_db),
):
    """
    General correction endpoint for an expense line — amount, category,
    payee, and (if already paid) the date paid / check number. Works
    whether the expense is still pending or already marked paid, since
    mistakes get caught at either stage.
    """
    entry = db.query(CheckRegisterEntry).filter(CheckRegisterEntry.id == entry_id, CheckRegisterEntry.entry_type == "expense").first()
    if not entry:
        raise HTTPException(status_code=404, detail="Expense entry not found")
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be positive")

    old = f"amount={entry.amount} category={entry.category} payee={entry.payee_name} date_paid={entry.date_paid} check_number={entry.check_number}"

    entry.amount = payload.amount
    entry.category = payload.category
    entry.payee_name = payload.payee_name.strip() if payload.payee_name else None

    if entry.status == "paid":
        if payload.date_paid is not None:
            entry.date_paid = payload.date_paid
        if payload.check_number is not None:
            if not payload.check_number.strip():
                raise HTTPException(status_code=400, detail="Check number cannot be blank once marked paid")
            entry.check_number = payload.check_number.strip()

    _touch_edited(db, entry, current_user)
    db.commit()

    log_audit_event(
        db, current_user.id, "check_register_expense_edited",
        resource_type="check_register_entry", resource_id=entry.id,
        details=f"{old} -> amount={entry.amount} category={entry.category} payee={entry.payee_name} date_paid={entry.date_paid} check_number={entry.check_number}",
    )

    return {"message": "Expense updated"}


class MarkPaidUpdate(BaseModel):
    date_paid: date
    check_number: str


class PayeeNameUpdate(BaseModel):
    payee_name: str


@router.put("/expense/{entry_id}/payee")
def update_payee_name(
    entry_id: str,
    payload: PayeeNameUpdate,
    current_user: User = Depends(require_role(Role.ADMIN, Role.FINANCIAL_SECRETARY)),
    db: Session = Depends(get_db),
):
    """
    Corrects who a check gets written to, directly on the register
    entry — for a spelling fix or a team mistake the Financial
    Secretary catches before cutting the check. Works whether the
    expense is still pending or already paid.
    """
    entry = db.query(CheckRegisterEntry).filter(CheckRegisterEntry.id == entry_id, CheckRegisterEntry.entry_type == "expense").first()
    if not entry:
        raise HTTPException(status_code=404, detail="Expense entry not found")

    old_value = entry.payee_name
    entry.payee_name = payload.payee_name.strip() or None
    _touch_edited(db, entry, current_user)
    db.commit()

    log_audit_event(
        db, current_user.id, "check_register_payee_name_corrected",
        resource_type="check_register_entry", resource_id=entry.id,
        details=f"'{old_value}' -> '{entry.payee_name}'",
    )

    return {"message": "Payee name updated"}


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
    _touch_edited(db, entry, current_user)
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
