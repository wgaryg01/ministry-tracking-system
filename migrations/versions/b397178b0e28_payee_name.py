"""add payee_name to activities and check register entries

Revision ID: b397178b0e28
Revises: 383e1ac1cfc4
Create Date: 2026-09-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "b397178b0e28"
down_revision: Union[str, None] = "383e1ac1cfc4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("activity_records", sa.Column("payee_name", sa.String(), nullable=True))
    op.add_column("check_register_entries", sa.Column("payee_name", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("check_register_entries", "payee_name")
    op.drop_column("activity_records", "payee_name")
