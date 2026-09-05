"""add intake_method to identities

Revision ID: 91bdd3be5db1
Revises: 3f972eb9918c
Create Date: 2026-09-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "91bdd3be5db1"
down_revision: Union[str, None] = "3f972eb9918c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("identities", sa.Column("intake_method", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("identities", "intake_method")
