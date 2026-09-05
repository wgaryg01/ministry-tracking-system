"""add financial secretary role and check register tables

Revision ID: 383e1ac1cfc4
Revises: 91bdd3be5db1
Create Date: 2026-09-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "383e1ac1cfc4"
down_revision: Union[str, None] = "91bdd3be5db1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Postgres enum types can't have a value removed in a downgrade,
    # so this is a one-way door — consistent with how Postgres enums
    # always work, not something specific to this migration.
    op.execute("ALTER TYPE role ADD VALUE IF NOT EXISTS 'FINANCIAL_SECRETARY'")

    op.create_table(
        "check_register_entries",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("entry_type", sa.String(), nullable=False),
        sa.Column("amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("transaction_date", sa.Date(), nullable=False),
        sa.Column("activity_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("activity_records.id"), nullable=True),
        sa.Column("category", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("date_paid", sa.Date(), nullable=True),
        sa.Column("check_number", sa.String(), nullable=True),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("paid_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.alter_column("check_register_entries", "status", server_default=None)

    op.create_table(
        "check_register_starting_balance",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("balance", sa.Numeric(10, 2), nullable=False),
        sa.Column("as_of_date", sa.Date(), nullable=False),
        sa.Column("set_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )

    op.create_table(
        "fiscal_year_budgets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("fiscal_year", sa.Integer(), nullable=False, unique=True),
        sa.Column("budget_amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("set_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("fiscal_year_budgets")
    op.drop_table("check_register_starting_balance")
    op.drop_table("check_register_entries")
    # Not reverting the enum value — Postgres doesn't support removing
    # a value from an existing enum type without rebuilding it entirely.
