"""make users.email nullable for phone-only accounts

Revision ID: 7f509e4d7a02
Revises: d44d1ac81c66
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "7f509e4d7a02"
down_revision: Union[str, None] = "d44d1ac81c66"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("users", "email", nullable=True)


def downgrade() -> None:
    op.alter_column("users", "email", nullable=False)
