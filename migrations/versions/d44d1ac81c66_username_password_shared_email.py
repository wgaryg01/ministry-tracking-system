"""add username and password_hash, drop email uniqueness

Revision ID: d44d1ac81c66
Revises: 78c9e4e2f87c
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "d44d1ac81c66"
down_revision: Union[str, None] = "78c9e4e2f87c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("username", sa.String(), nullable=True))
    op.create_index("ix_users_username", "users", ["username"], unique=True)
    op.add_column("users", sa.Column("password_hash", sa.String(), nullable=True))

    # email was originally unique+indexed as a single index named
    # ix_users_email (SQLAlchemy's default naming for Column(unique=True,
    # index=True) with no separate UniqueConstraint object). Recreate it
    # as non-unique so multiple accounts can share an inbox.
    op.drop_index("ix_users_email", table_name="users")
    op.create_index("ix_users_email", "users", ["email"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_users_email", table_name="users")
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.drop_column("users", "password_hash")
    op.drop_index("ix_users_username", table_name="users")
    op.drop_column("users", "username")
