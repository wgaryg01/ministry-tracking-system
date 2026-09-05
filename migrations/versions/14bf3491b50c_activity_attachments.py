"""add activity_attachments table

Revision ID: 14bf3491b50c
Revises: 433c1c398f3c
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "14bf3491b50c"
down_revision: Union[str, None] = "433c1c398f3c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "activity_attachments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("activity_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("activity_records.id"), nullable=False),
        sa.Column("filename", sa.String(), nullable=False),
        sa.Column("content_type", sa.String(), nullable=True),
        sa.Column("encrypted_file_data", sa.LargeBinary(), nullable=False),
        sa.Column("uploaded_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("uploaded_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_activity_attachments_activity_id", "activity_attachments", ["activity_id"])


def downgrade() -> None:
    op.drop_index("ix_activity_attachments_activity_id", table_name="activity_attachments")
    op.drop_table("activity_attachments")
