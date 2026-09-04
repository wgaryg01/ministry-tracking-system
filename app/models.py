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
    Boolean,
    Integer,
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
    # Not unique — a household can share one inbox across two accounts
    # (e.g. husband and wife). username (below) is the actual unique
    # sign-in identifier; email is just where mail goes.
    email = Column(String, nullable=True, index=True)
    username = Column(String, unique=True, nullable=True, index=True)  # required before password sign-in works
    password_hash = Column(String, nullable=True)  # bcrypt hash; null until the user completes setup
    full_name = Column(String, nullable=True)  # self-managed, plain text — like email, not client PII
    role = Column(Enum(Role), nullable=False, default=Role.VOLUNTEER)
    is_active = Column(Boolean, nullable=False, default=True)  # a manual on/off switch, independent of TEAMMEMBER term dates
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

    # Self-managed notification preferences — this is the user's own
    # operational contact info (not client PII), so it's stored plainly
    # like email, not encrypted/RBAC-gated.
    phone_number = Column(String, nullable=True)
    notify_email = Column(Boolean, nullable=False, default=True)
    notify_sms = Column(Boolean, nullable=False, default=False)


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
    of the SSL-encrypted connection). Only ADMIN (while elevated) or
    TEAMMEMBER code paths should ever call the decrypt helper on these
    columns.
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
    addresses = relationship("Address", back_populates="identity", order_by="Address.effective_date")
    household_members = relationship("HouseholdMember", back_populates="identity")


class ActivityRecord(Base):
    """
    Records that someone was helped, on what date, and how much was
    spent — with NO identifying fields. Lower-privilege roles query
    this table directly and see identity_id (a UUID) but nothing that
    resolves it to a name without going through the Identity table,
    which their role is not permitted to decrypt.

    An activity can also represent something scheduled for the future
    (status="scheduled", amount_spent still null) rather than something
    already done (status="completed"). scheduled_at carries the precise
    date+time when future notification timing matters; activity_date
    remains the plain date used for ledger grouping either way.
    """
    __tablename__ = "activity_records"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    identity_id = Column(UUID(as_uuid=True), ForeignKey("identities.id"), nullable=False)
    activity_date = Column(Date, nullable=False, default=date.today)
    amount_spent = Column(Numeric(10, 2), nullable=True)
    category = Column(String, nullable=True)  # e.g. "groceries", "utilities", "rent"

    # Encrypted like Identity's PII fields — may describe a client's
    # situation, so it's gated by the same can_decrypt_pii check.
    encrypted_notes = Column(LargeBinary, nullable=True)

    status = Column(String, nullable=False, default="completed")  # "scheduled" | "completed" | "cancelled"
    scheduled_at = Column(DateTime, nullable=True)  # precise date+time, only meaningful when status="scheduled"

    logged_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    identity = relationship("Identity", back_populates="activities")
    assignments = relationship("ActivityAssignment", back_populates="activity")
    notification_rules = relationship("NotificationRule", back_populates="activity")


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


class OrgSettings(Base):
    """
    Singleton row (there's only ever one) holding the ministry's display
    name and logo. Editable only by ADMIN. The logo is stored as bytes
    directly in Postgres — it rides along with normal DB backups rather
    than needing a separate file-storage volume.
    """
    __tablename__ = "org_settings"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ministry_name = Column(String, nullable=False, default="Ministry")
    logo_data = Column(LargeBinary, nullable=True)
    logo_content_type = Column(String, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    updated_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)


class Address(Base):
    """
    One row per address a person has had — append-only, never edited or
    deleted. The "current" address is simply the row with the latest
    effective_date. This gives a full move history (with dates) for
    free, rather than overwriting a single address field.
    """
    __tablename__ = "addresses"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    identity_id = Column(UUID(as_uuid=True), ForeignKey("identities.id"), nullable=False, index=True)
    encrypted_address = Column(LargeBinary, nullable=False)
    effective_date = Column(Date, nullable=False, default=date.today)
    created_at = Column(DateTime, default=datetime.utcnow)

    identity = relationship("Identity", back_populates="addresses")


class ActivityAssignment(Base):
    """Which team members are assigned to a given activity (usually a scheduled one)."""
    __tablename__ = "activity_assignments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    activity_id = Column(UUID(as_uuid=True), ForeignKey("activity_records.id"), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    activity = relationship("ActivityRecord", back_populates="assignments")


class NotificationRule(Base):
    """
    One 'notify this many minutes before scheduled_at' rule for an
    activity. An activity can have several — e.g. one rule for a week
    before, one for a day before, one for an hour before — fully
    flexible, not limited to any fixed set.
    """
    __tablename__ = "notification_rules"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    activity_id = Column(UUID(as_uuid=True), ForeignKey("activity_records.id"), nullable=False, index=True)
    offset_minutes = Column(Integer, nullable=False)  # e.g. 60 = "1 hour before", 1440 = "1 day before"
    created_at = Column(DateTime, default=datetime.utcnow)

    activity = relationship("ActivityRecord", back_populates="notification_rules")


class NotificationSend(Base):
    """
    Idempotency log — one row per (rule, recipient, channel) actually
    sent, so the scheduler never double-sends the same notification.
    """
    __tablename__ = "notification_sends"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    notification_rule_id = Column(UUID(as_uuid=True), ForeignKey("notification_rules.id"), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    channel = Column(String, nullable=False)  # "email" | "sms"
    status = Column(String, nullable=False)  # "sent" | "failed"
    error_detail = Column(String, nullable=True)
    sent_at = Column(DateTime, default=datetime.utcnow)


class HouseholdMember(Base):
    """
    A child or other adult living with the applicant — from the intake
    form's household section. Name and relationship are encrypted like
    the rest of Identity's PII; age is a plain integer since it isn't
    identifying on its own. Household totals (adults/children/total)
    are always computed from these rows plus the applicant themself —
    never stored, so there's nothing to drift out of sync.
    """
    __tablename__ = "household_members"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    identity_id = Column(UUID(as_uuid=True), ForeignKey("identities.id"), nullable=False, index=True)
    member_type = Column(String, nullable=False)  # "child" | "adult"
    encrypted_name = Column(LargeBinary, nullable=False)
    age = Column(Integer, nullable=True)
    encrypted_relationship = Column(LargeBinary, nullable=True)  # e.g. "daughter", "spouse", "roommate"
    created_at = Column(DateTime, default=datetime.utcnow)

    identity = relationship("Identity", back_populates="household_members")
