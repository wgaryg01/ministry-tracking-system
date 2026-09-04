"""add addresses table

Revision ID: ec706ba7613d
Revises: 244929794d7b
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "ec706ba7613d"
down_revision: Union[str, None] = "244929794d7b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "addresses",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("identity_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("identities.id"), nullable=False),
        sa.Column("encrypted_address", sa.LargeBinary(), nullable=False),
        sa.Column("effective_date", sa.Date(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_addresses_identity_id", "addresses", ["identity_id"])


def downgrade() -> None:
    op.drop_index("ix_addresses_identity_id", table_name="addresses")
    op.drop_table("addresses")
