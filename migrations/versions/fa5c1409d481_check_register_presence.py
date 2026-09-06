"""add check register presence and edit attribution

Revision ID: fa5c1409d481
Revises: b397178b0e28
Create Date: 2026-09-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "fa5c1409d481"
down_revision: Union[str, None] = "b397178b0e28"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("check_register_entries", sa.Column("last_edited_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True))
    op.add_column("check_register_entries", sa.Column("last_edited_at", sa.DateTime(), nullable=True))

    op.create_table(
        "check_register_presence",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False, unique=True),
        sa.Column("last_seen_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("check_register_presence")
    op.drop_column("check_register_entries", "last_edited_at")
    op.drop_column("check_register_entries", "last_edited_by_user_id")
