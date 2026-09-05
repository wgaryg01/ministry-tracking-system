"""split full_name into first_name/last_name

Revision ID: 1d0f713d3850
Revises: 3f94cab491b1
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "1d0f713d3850"
down_revision: Union[str, None] = "3f94cab491b1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # DB-nullable (existing test records will have blank first/last
    # name until re-entered via Edit — same pattern as other
    # restructuring this session); "required" is enforced by the API
    # on new/edited records, not a hard DB constraint.
    op.add_column("identities", sa.Column("encrypted_first_name", sa.LargeBinary(), nullable=True))
    op.add_column("identities", sa.Column("encrypted_last_name", sa.LargeBinary(), nullable=True))
    op.drop_column("identities", "encrypted_full_name")


def downgrade() -> None:
    op.add_column("identities", sa.Column("encrypted_full_name", sa.LargeBinary(), nullable=True))
    op.drop_column("identities", "encrypted_last_name")
    op.drop_column("identities", "encrypted_first_name")
