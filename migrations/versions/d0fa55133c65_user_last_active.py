"""add last_active_at to users

Revision ID: d0fa55133c65
Revises: d04f38e81014
Create Date: 2026-09-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "d0fa55133c65"
down_revision: Union[str, None] = "d04f38e81014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("last_active_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "last_active_at")
