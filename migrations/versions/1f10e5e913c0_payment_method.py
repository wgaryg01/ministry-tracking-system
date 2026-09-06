"""add payment_method to requests and check register entries

Revision ID: 1f10e5e913c0
Revises: 0c765457f556
Create Date: 2026-09-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "1f10e5e913c0"
down_revision: Union[str, None] = "0c765457f556"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("assistance_requests", sa.Column("payment_method", sa.String(), nullable=True))
    op.add_column("check_register_entries", sa.Column("payment_method", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("check_register_entries", "payment_method")
    op.drop_column("assistance_requests", "payment_method")
