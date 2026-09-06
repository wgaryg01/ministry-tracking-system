"""add edit attribution to identities, requests, and activities

Revision ID: 0c765457f556
Revises: fa5c1409d481
Create Date: 2026-09-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0c765457f556"
down_revision: Union[str, None] = "fa5c1409d481"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for table in ("identities", "assistance_requests", "activity_records"):
        op.add_column(table, sa.Column("last_edited_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True))
        op.add_column(table, sa.Column("last_edited_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    for table in ("identities", "assistance_requests", "activity_records"):
        op.drop_column(table, "last_edited_at")
        op.drop_column(table, "last_edited_by_user_id")
