"""add payment_approved to activity_records

Revision ID: 4ffc55217c86
Revises: 14bf3491b50c
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "4ffc55217c86"
down_revision: Union[str, None] = "14bf3491b50c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("activity_records", sa.Column("payment_approved", sa.Boolean(), nullable=False, server_default="false"))
    op.alter_column("activity_records", "payment_approved", server_default=None)


def downgrade() -> None:
    op.drop_column("activity_records", "payment_approved")
