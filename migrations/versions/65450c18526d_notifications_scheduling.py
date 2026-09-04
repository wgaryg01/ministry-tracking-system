"""activity notes/scheduling, notification prefs, assignments, rules

Revision ID: 65450c18526d
Revises: ec706ba7613d
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "65450c18526d"
down_revision: Union[str, None] = "ec706ba7613d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ActivityRecord additions
    op.add_column("activity_records", sa.Column("encrypted_notes", sa.LargeBinary(), nullable=True))
    op.add_column("activity_records", sa.Column("status", sa.String(), nullable=False, server_default="completed"))
    op.add_column("activity_records", sa.Column("scheduled_at", sa.DateTime(), nullable=True))
    op.alter_column("activity_records", "status", server_default=None)  # drop default after backfill

    # User notification preferences
    op.add_column("users", sa.Column("phone_number", sa.String(), nullable=True))
    op.add_column("users", sa.Column("notify_email", sa.Boolean(), nullable=False, server_default="true"))
    op.add_column("users", sa.Column("notify_sms", sa.Boolean(), nullable=False, server_default="false"))
    op.alter_column("users", "notify_email", server_default=None)
    op.alter_column("users", "notify_sms", server_default=None)

    op.create_table(
        "activity_assignments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("activity_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("activity_records.id"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_activity_assignments_activity_id", "activity_assignments", ["activity_id"])
    op.create_index("ix_activity_assignments_user_id", "activity_assignments", ["user_id"])

    op.create_table(
        "notification_rules",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("activity_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("activity_records.id"), nullable=False),
        sa.Column("offset_minutes", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_notification_rules_activity_id", "notification_rules", ["activity_id"])

    op.create_table(
        "notification_sends",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("notification_rule_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("notification_rules.id"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("channel", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("error_detail", sa.String(), nullable=True),
        sa.Column("sent_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_notification_sends_rule_id", "notification_sends", ["notification_rule_id"])


def downgrade() -> None:
    op.drop_index("ix_notification_sends_rule_id", table_name="notification_sends")
    op.drop_table("notification_sends")
    op.drop_index("ix_notification_rules_activity_id", table_name="notification_rules")
    op.drop_table("notification_rules")
    op.drop_index("ix_activity_assignments_user_id", table_name="activity_assignments")
    op.drop_index("ix_activity_assignments_activity_id", table_name="activity_assignments")
    op.drop_table("activity_assignments")

    op.drop_column("users", "notify_sms")
    op.drop_column("users", "notify_email")
    op.drop_column("users", "phone_number")

    op.drop_column("activity_records", "scheduled_at")
    op.drop_column("activity_records", "status")
    op.drop_column("activity_records", "encrypted_notes")
