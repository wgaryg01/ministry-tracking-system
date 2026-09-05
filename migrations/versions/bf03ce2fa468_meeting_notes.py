"""add meeting_notes and meeting_attendance tables

Revision ID: bf03ce2fa468
Revises: 1c75112e5748
Create Date: 2026-09-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "bf03ce2fa468"
down_revision: Union[str, None] = "1c75112e5748"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "meeting_notes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("meeting_datetime", sa.DateTime(), nullable=False),
        sa.Column("location", sa.String(), nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("redacted_transcript", sa.Text(), nullable=True),
        sa.Column("encrypted_raw_transcript", sa.LargeBinary(), nullable=True),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_table(
        "meeting_attendance",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("meeting_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("meeting_notes.id"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
    )
    op.create_index("ix_meeting_attendance_meeting_id", "meeting_attendance", ["meeting_id"])


def downgrade() -> None:
    op.drop_index("ix_meeting_attendance_meeting_id", table_name="meeting_attendance")
    op.drop_table("meeting_attendance")
    op.drop_table("meeting_notes")
