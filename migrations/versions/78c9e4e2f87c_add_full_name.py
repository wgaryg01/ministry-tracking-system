"""add full_name to users

Revision ID: 78c9e4e2f87c
Revises: 65450c18526d
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "78c9e4e2f87c"
down_revision: Union[str, None] = "65450c18526d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("full_name", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "full_name")
