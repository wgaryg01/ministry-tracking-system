"""add duration_minutes to meeting_notes

Revision ID: 8a1f6f2af5ab
Revises: bf03ce2fa468
Create Date: 2026-09-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "8a1f6f2af5ab"
down_revision: Union[str, None] = "bf03ce2fa468"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("meeting_notes", sa.Column("duration_minutes", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("meeting_notes", "duration_minutes")
