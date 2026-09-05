"""add theme_colors to org_settings

Revision ID: c365129bbb0b
Revises: d0fa55133c65
Create Date: 2026-09-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "c365129bbb0b"
down_revision: Union[str, None] = "d0fa55133c65"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("org_settings", sa.Column("theme_colors", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("org_settings", "theme_colors")
