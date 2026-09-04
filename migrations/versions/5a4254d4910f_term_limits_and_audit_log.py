"""add term limits to users and audit_log table

Revision ID: 5a4254d4910f
Revises: e1031c8f1c67
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "5a4254d4910f"
down_revision: Union[str, None] = "e1031c8f1c67"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("term_start_date", sa.Date(), nullable=True))
    op.add_column("users", sa.Column("term_end_date", sa.Date(), nullable=True))
    op.add_column("users", sa.Column("invitation_sent_at", sa.DateTime(), nullable=True))

    op.create_table(
        "audit_log",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("resource_type", sa.String(), nullable=True),
        sa.Column("resource_id", sa.String(), nullable=True),
        sa.Column("details", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("audit_log")
    op.drop_column("users", "invitation_sent_at")
    op.drop_column("users", "term_end_date")
    op.drop_column("users", "term_start_date")
