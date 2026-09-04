import uuid
from datetime import date, datetime

from sqlalchemy import (
    Column,
    String,
    Date,
    DateTime,
    Numeric,
    ForeignKey,
    Enum,
    LargeBinary,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import declarative_base, relationship
import enum

Base = declarative_base()


class Role(str, enum.Enum):
    ADMIN = "admin"          # can decrypt PII, manage org settings
    CASEWORKER = "caseworker"  # can decrypt PII, log activity
    VOLUNTEER = "volunteer"    # sees activity totals + identity_id only, never PII


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String, unique=True, nullable=False, index=True)
    role = Column(Enum(Role), nullable=False, default=Role.VOLUNTEER)
    created_at = Column(DateTime, default=datetime.utcnow)


class MagicLinkToken(Base):
    __tablename__ = "magic_link_tokens"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    token_hash = Column(String, nullable=False, index=True)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)


class Identity(Base):
    """
    Holds the actual person record. Every PII field is stored as
    encrypted bytes (application-layer encryption via Fernet, on top
    of the SSL-encrypted connection). Only ADMIN/CASEWORKER-role code
    paths should ever call the decrypt helper on these columns.
    """
    __tablename__ = "identities"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # All PII lives here, encrypted at rest.
    encrypted_full_name = Column(LargeBinary, nullable=False)
    encrypted_dob = Column(LargeBinary, nullable=True)
    encrypted_contact_info = Column(LargeBinary, nullable=True)
    encrypted_notes = Column(LargeBinary, nullable=True)

    # Searchable blind index (HMAC of normalized name/phone) so
    # authorized roles can look someone up without a full table decrypt.
    search_hash = Column(String, nullable=True, index=True)

    created_at = Column(DateTime, default=datetime.utcnow)

    activities = relationship("ActivityRecord", back_populates="identity")


class ActivityRecord(Base):
    """
    Records that someone was helped, on what date, and how much was
    spent — with NO identifying fields. Lower-privilege roles query
    this table directly and see identity_id (a UUID) but nothing that
    resolves it to a name without going through the Identity table,
    which their role is not permitted to decrypt.
    """
    __tablename__ = "activity_records"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    identity_id = Column(UUID(as_uuid=True), ForeignKey("identities.id"), nullable=False)
    activity_date = Column(Date, nullable=False, default=date.today)
    amount_spent = Column(Numeric(10, 2), nullable=True)
    category = Column(String, nullable=True)  # e.g. "groceries", "utilities", "rent"
    logged_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    identity = relationship("Identity", back_populates="activities")
