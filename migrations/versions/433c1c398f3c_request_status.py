"""add status to assistance_requests

Revision ID: 433c1c398f3c
Revises: 1d0f713d3850
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "433c1c398f3c"
down_revision: Union[str, None] = "1d0f713d3850"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("assistance_requests", sa.Column("status", sa.String(), nullable=False, server_default="new"))
    op.alter_column("assistance_requests", "status", server_default=None)


def downgrade() -> None:
    op.drop_column("assistance_requests", "status")
