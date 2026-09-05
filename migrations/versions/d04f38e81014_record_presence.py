"""add record_presence table

Revision ID: d04f38e81014
Revises: 8a1f6f2af5ab
Create Date: 2026-09-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "d04f38e81014"
down_revision: Union[str, None] = "8a1f6f2af5ab"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "record_presence",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("identity_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("identities.id"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_record_presence_identity_id", "record_presence", ["identity_id"])
    op.create_unique_constraint("uq_record_presence_identity_user", "record_presence", ["identity_id", "user_id"])


def downgrade() -> None:
    op.drop_constraint("uq_record_presence_identity_user", "record_presence", type_="unique")
    op.drop_index("ix_record_presence_identity_id", table_name="record_presence")
    op.drop_table("record_presence")
