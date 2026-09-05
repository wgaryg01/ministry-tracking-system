"""add request_votes table

Revision ID: 1c75112e5748
Revises: 4ffc55217c86
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "1c75112e5748"
down_revision: Union[str, None] = "4ffc55217c86"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "request_votes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("assistance_request_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("assistance_requests.id"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("support", sa.Boolean(), nullable=False),
        sa.Column("voted_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_request_votes_request_id", "request_votes", ["assistance_request_id"])
    op.create_index("ix_request_votes_user_id", "request_votes", ["user_id"])
    op.create_unique_constraint("uq_request_votes_request_user", "request_votes", ["assistance_request_id", "user_id"])


def downgrade() -> None:
    op.drop_constraint("uq_request_votes_request_user", "request_votes", type_="unique")
    op.drop_index("ix_request_votes_user_id", table_name="request_votes")
    op.drop_index("ix_request_votes_request_id", table_name="request_votes")
    op.drop_table("request_votes")
