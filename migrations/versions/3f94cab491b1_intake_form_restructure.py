"""restructure to match intake form: requests, documents, structured address

Revision ID: 3f94cab491b1
Revises: d512a2f9f28a
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "3f94cab491b1"
down_revision: Union[str, None] = "d512a2f9f28a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Per explicit instruction: wipe existing activity data — the old
    # identity_id-linked shape is being replaced by request_id-linked,
    # and sample data will be re-entered under the new structure.
    op.execute("DELETE FROM notification_sends")
    op.execute("DELETE FROM notification_rules")
    op.execute("DELETE FROM activity_assignments")
    op.execute("DELETE FROM activity_records")

    # New tables
    op.create_table(
        "assistance_requests",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("identity_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("identities.id"), nullable=False),
        sa.Column("encrypted_assistance_type", sa.LargeBinary(), nullable=False),
        sa.Column("encrypted_situation_description", sa.LargeBinary(), nullable=True),
        sa.Column("applicant_acknowledged", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("acknowledged_date", sa.Date(), nullable=True),
        sa.Column("encrypted_helper_name", sa.LargeBinary(), nullable=True),
        sa.Column("encrypted_helper_contact", sa.LargeBinary(), nullable=True),
        sa.Column("encrypted_helper_relationship", sa.LargeBinary(), nullable=True),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_assistance_requests_identity_id", "assistance_requests", ["identity_id"])
    op.alter_column("assistance_requests", "applicant_acknowledged", server_default=None)

    op.create_table(
        "request_documents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("assistance_request_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("assistance_requests.id"), nullable=False),
        sa.Column("filename", sa.String(), nullable=False),
        sa.Column("content_type", sa.String(), nullable=True),
        sa.Column("encrypted_file_data", sa.LargeBinary(), nullable=False),
        sa.Column("uploaded_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("uploaded_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_request_documents_request_id", "request_documents", ["assistance_request_id"])

    # activity_records: drop identity_id, add assistance_request_id (table is
    # empty now, so NOT NULL is safe to add directly)
    op.drop_column("activity_records", "identity_id")
    op.add_column("activity_records", sa.Column("assistance_request_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("assistance_requests.id"), nullable=False))
    op.create_index("ix_activity_records_request_id", "activity_records", ["assistance_request_id"])

    # identities: add new Applicant Info / Employment Info / referral columns
    op.add_column("identities", sa.Column("encrypted_phone", sa.LargeBinary(), nullable=True))
    op.add_column("identities", sa.Column("encrypted_email", sa.LargeBinary(), nullable=True))
    op.add_column("identities", sa.Column("encrypted_employment_status", sa.LargeBinary(), nullable=True))
    op.add_column("identities", sa.Column("encrypted_employer_name", sa.LargeBinary(), nullable=True))
    op.add_column("identities", sa.Column("encrypted_job_title", sa.LargeBinary(), nullable=True))
    op.add_column("identities", sa.Column("encrypted_referral_source", sa.LargeBinary(), nullable=True))
    op.add_column("identities", sa.Column("encrypted_referral_name", sa.LargeBinary(), nullable=True))

    # Best-effort carry-over: old encrypted_contact_info ciphertext becomes
    # the new encrypted_phone ciphertext directly (same encryption key/scheme,
    # no decrypt/re-encrypt needed since it's a straight column copy).
    op.execute("UPDATE identities SET encrypted_phone = encrypted_contact_info WHERE encrypted_contact_info IS NOT NULL")

    op.drop_column("identities", "encrypted_dob")
    op.drop_column("identities", "encrypted_contact_info")

    # addresses: replace single encrypted_address blob with structured fields
    op.add_column("addresses", sa.Column("encrypted_street", sa.LargeBinary(), nullable=True))
    op.add_column("addresses", sa.Column("encrypted_unit", sa.LargeBinary(), nullable=True))
    op.add_column("addresses", sa.Column("encrypted_city", sa.LargeBinary(), nullable=True))
    op.add_column("addresses", sa.Column("encrypted_state", sa.LargeBinary(), nullable=True))
    op.add_column("addresses", sa.Column("encrypted_zip", sa.LargeBinary(), nullable=True))
    op.execute("UPDATE addresses SET encrypted_street = encrypted_address WHERE encrypted_address IS NOT NULL")
    op.drop_column("addresses", "encrypted_address")


def downgrade() -> None:
    op.add_column("addresses", sa.Column("encrypted_address", sa.LargeBinary(), nullable=True))
    op.execute("UPDATE addresses SET encrypted_address = encrypted_street WHERE encrypted_street IS NOT NULL")
    op.drop_column("addresses", "encrypted_zip")
    op.drop_column("addresses", "encrypted_state")
    op.drop_column("addresses", "encrypted_city")
    op.drop_column("addresses", "encrypted_unit")
    op.drop_column("addresses", "encrypted_street")

    op.add_column("identities", sa.Column("encrypted_contact_info", sa.LargeBinary(), nullable=True))
    op.execute("UPDATE identities SET encrypted_contact_info = encrypted_phone WHERE encrypted_phone IS NOT NULL")
    op.add_column("identities", sa.Column("encrypted_dob", sa.LargeBinary(), nullable=True))
    op.drop_column("identities", "encrypted_referral_name")
    op.drop_column("identities", "encrypted_referral_source")
    op.drop_column("identities", "encrypted_job_title")
    op.drop_column("identities", "encrypted_employer_name")
    op.drop_column("identities", "encrypted_employment_status")
    op.drop_column("identities", "encrypted_email")
    op.drop_column("identities", "encrypted_phone")

    op.drop_index("ix_activity_records_request_id", table_name="activity_records")
    op.drop_column("activity_records", "assistance_request_id")
    op.add_column("activity_records", sa.Column("identity_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("identities.id"), nullable=True))

    op.drop_index("ix_request_documents_request_id", table_name="request_documents")
    op.drop_table("request_documents")

    op.drop_index("ix_assistance_requests_identity_id", table_name="assistance_requests")
    op.drop_table("assistance_requests")
