"""rename role CASEWORKER to TEAMMEMBER

Revision ID: e1b584dbf7c9
Revises: 0090a4846372
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e1b584dbf7c9"
down_revision: Union[str, None] = "0090a4846372"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Renames the enum value in place — any existing rows already set to
    # 'CASEWORKER' automatically become 'TEAMMEMBER'. Requires Postgres 10+.
    op.execute("ALTER TYPE role RENAME VALUE 'CASEWORKER' TO 'TEAMMEMBER'")


def downgrade() -> None:
    op.execute("ALTER TYPE role RENAME VALUE 'TEAMMEMBER' TO 'CASEWORKER'")
