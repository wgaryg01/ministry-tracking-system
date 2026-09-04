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
    ADMIN = "admin"            # manages org settings/users; does NOT decrypt PII by default
    TEAMMEMBER = "teammember"  # can decrypt PII, logs activity — the role that actually works with client identities
    VOLUNTEER = "volunteer"    # sees activity totals + identity_id only, never PII


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String, unique=True, nullable=False, index=True)
    role = Column(Enum(Role), nullable=False, default=Role.VOLUNTEER)
    created_at = Column(DateTime, default=datetime.utcnow)

    # Term limits — required for TEAMMEMBER (church-appointed terms),
    # unused for ADMIN/VOLUNTEER. Enforced at sign-in: a TEAMMEMBER
    # outside their [term_start_date, term_end_date] window is denied,
    # even mid-session.
    term_start_date = Column(Date, nullable=True)
    term_end_date = Column(Date, nullable=True)

    # Set once the invitation magic-link email has actually been sent,
    # so the scheduled job never sends it twice.
    invitation_sent_at = Column(DateTime, nullable=True)


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


class ElevationGrant(Base):
    """
    A time-limited, reason-logged grant allowing an ADMIN to decrypt PII.
    TEAMMEMBER users never need this — they can always decrypt.
    VOLUNTEER users are never eligible for elevation.
    """
    __tablename__ = "elevation_grants"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    reason = Column(String, nullable=False)
    granted_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)
    revoked_at = Column(DateTime, nullable=True)


class PiiAccessLog(Base):
    """
    Records every time a PII field is actually decrypted and by whom —
    separate from ElevationGrant, which only records that permission
    was temporarily granted. This is the "who actually looked at what"
    trail, regardless of which role or grant made it possible.
    """
    __tablename__ = "pii_access_log"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    identity_id = Column(UUID(as_uuid=True), ForeignKey("identities.id"), nullable=False)
    accessed_at = Column(DateTime, default=datetime.utcnow)
    via_elevation = Column(String, nullable=True)  # elevation_grants.id as string, or null if via TEAMMEMBER role


class AuditLog(Base):
    """
    General audit trail for state-changing actions and auth events —
    invitations, term changes, logins, elevation requests/revokes,
    identity/activity creation. PII decrypts have their own dedicated
    PiiAccessLog above (kept separate since it's checked on the hot
    path of every identity lookup). Read/list endpoints are not
    logged here currently.
    """
    __tablename__ = "audit_log"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)  # null for failed/anonymous events
    action = Column(String, nullable=False)  # e.g. "user_invited", "login", "elevation_requested"
    resource_type = Column(String, nullable=True)  # e.g. "identity", "user"
    resource_id = Column(String, nullable=True)
    details = Column(String, nullable=True)  # short free-text context, not PII
    created_at = Column(DateTime, default=datetime.utcnow)
