"""add household_members table

Revision ID: d512a2f9f28a
Revises: 7e8845b35dd2
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "d512a2f9f28a"
down_revision: Union[str, None] = "7e8845b35dd2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "household_members",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("identity_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("identities.id"), nullable=False),
        sa.Column("member_type", sa.String(), nullable=False),
        sa.Column("encrypted_name", sa.LargeBinary(), nullable=False),
        sa.Column("age", sa.Integer(), nullable=True),
        sa.Column("encrypted_relationship", sa.LargeBinary(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_household_members_identity_id", "household_members", ["identity_id"])


def downgrade() -> None:
    op.drop_index("ix_household_members_identity_id", table_name="household_members")
    op.drop_table("household_members")
