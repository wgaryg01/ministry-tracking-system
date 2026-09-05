import uuid
from datetime import date, datetime

from sqlalchemy import (
    Column,
    String,
    Text,
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

    # Brute-force protection on password sign-in. Reset to 0/None on
    # any successful login; incremented on each wrong password.
    failed_login_attempts = Column(Integer, nullable=False, default=0)
    locked_until = Column(DateTime, nullable=True)

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

    # Site-wide "who's online" — separate from per-record presence
    # (RecordPresence). Updated by a global heartbeat while the app
    # is open, regardless of which page is showing.
    last_active_at = Column(DateTime, nullable=True)


class MagicLinkToken(Base):
    __tablename__ = "magic_link_tokens"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    token_hash = Column(String, nullable=False, index=True)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)


class Identity(Base):
    """
    Holds the actual person record, mirroring the paper intake form:
    Applicant Info, Employment Info, and referral source ("how did you
    hear about us") all live here. Household Info is the related
    HouseholdMember table below. Every PII field is encrypted at rest.
    Only ADMIN (while elevated) or TEAMMEMBER code paths should ever
    call the decrypt helper on these columns.
    """
    __tablename__ = "identities"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # Applicant Info — required at intake via API validation, not a
    # hard DB constraint, so existing/historical records without this
    # structured data don't break. First/last stored separately (not
    # just a full-name blob) so sorting by name is a real, reliable
    # sort key rather than parsed from free text.
    encrypted_first_name = Column(LargeBinary, nullable=False)
    encrypted_last_name = Column(LargeBinary, nullable=False)
    encrypted_phone = Column(LargeBinary, nullable=True)
    encrypted_email = Column(LargeBinary, nullable=True)  # optional per the form
    encrypted_notes = Column(LargeBinary, nullable=True)

    # Employment Info — encrypted_employment_status holds the
    # form's checkbox selections joined as one string (e.g.
    # "full_time|unable_to_work|other:seasonal work"), decrypted and
    # split back into a list for display.
    encrypted_employment_status = Column(LargeBinary, nullable=True)
    encrypted_employer_name = Column(LargeBinary, nullable=True)
    encrypted_job_title = Column(LargeBinary, nullable=True)

    # "How did you hear about us" — per-person, not per-request.
    encrypted_referral_source = Column(LargeBinary, nullable=True)  # same joined-list pattern as employment_status
    encrypted_referral_name = Column(LargeBinary, nullable=True)  # referring person/org, if any

    # How this record's data made it into the system — "church_office_form"
    # or "team_member_entered". Operational metadata about the intake
    # process itself, not something about the recipient, so left plain.
    intake_method = Column(String, nullable=True)

    # Searchable blind index (HMAC of normalized name/phone) so
    # authorized roles can look someone up without a full table decrypt.
    search_hash = Column(String, nullable=True, index=True)

    created_at = Column(DateTime, default=datetime.utcnow)

    addresses = relationship("Address", back_populates="identity", order_by="Address.effective_date")
    household_members = relationship("HouseholdMember", back_populates="identity")
    assistance_requests = relationship("AssistanceRequest", back_populates="identity")


class ActivityRecord(Base):
    """
    Records that help was given (or scheduled), on what date, and how
    much was spent — with NO identifying fields. Belongs to an
    AssistanceRequest (a "case"), not directly to a person — one
    request can have several activities under it (multiple visits,
    different kinds of aid, over time). Lower-privilege roles query
    this table and see the request/identity linkage only as UUIDs,
    never a name, without going through Identity, which their role
    isn't permitted to decrypt.

    An activity can also represent something scheduled for the future
    (status="scheduled", amount_spent still null) rather than something
    already done (status="completed"). scheduled_at carries the precise
    date+time when future notification timing matters; activity_date
    remains the plain date used for ledger grouping either way.
    """
    __tablename__ = "activity_records"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    assistance_request_id = Column(UUID(as_uuid=True), ForeignKey("assistance_requests.id"), nullable=False, index=True)
    activity_date = Column(Date, nullable=False, default=date.today)
    amount_spent = Column(Numeric(10, 2), nullable=True)
    category = Column(String, nullable=True)  # e.g. "groceries", "utilities", "rent"

    # Encrypted like Identity's PII fields — may describe a client's
    # situation, so it's gated by the same can_decrypt_pii check.
    encrypted_notes = Column(LargeBinary, nullable=True)

    status = Column(String, nullable=False, default="completed")  # "scheduled" | "completed" | "cancelled"
    scheduled_at = Column(DateTime, nullable=True)  # precise date+time, only meaningful when status="scheduled"

    # An amount is just a quote until this is true — no calculation of
    # money spent (request totals, org totals) ever includes an
    # unapproved amount.
    payment_approved = Column(Boolean, nullable=False, default=False)

    logged_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    assistance_request = relationship("AssistanceRequest", back_populates="activities")
    assignments = relationship("ActivityAssignment", back_populates="activity")
    notification_rules = relationship("NotificationRule", back_populates="activity")
    attachments = relationship("ActivityAttachment", back_populates="activity")


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
    theme_colors = Column(Text, nullable=True)  # JSON object of CSS variable name -> hex color, e.g. {"--brass": "#B9814F"}
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    updated_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)


class Address(Base):
    """
    One row per address a person has had — append-only, never edited or
    deleted. The "current" address is simply the row with the latest
    effective_date. This gives a full move history (with dates) for
    free, rather than overwriting a single address field. Structured
    to match the intake form's separate street/unit/city/state/zip
    fields rather than one free-text blob.
    """
    __tablename__ = "addresses"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    identity_id = Column(UUID(as_uuid=True), ForeignKey("identities.id"), nullable=False, index=True)
    encrypted_street = Column(LargeBinary, nullable=True)
    encrypted_unit = Column(LargeBinary, nullable=True)
    encrypted_city = Column(LargeBinary, nullable=True)
    encrypted_state = Column(LargeBinary, nullable=True)
    encrypted_zip = Column(LargeBinary, nullable=True)
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


class AssistanceRequest(Base):
    """
    A specific request for help — the "Assistance Requested" section
    of the intake form (type of assistance, situation description,
    the applicant's acknowledgment, and who helped them fill out the
    form, if anyone). One Identity can have several requests over
    time; each request can have several Activities under it (multiple
    visits or kinds of aid addressing that same request) and Documents
    attached to it.
    """
    __tablename__ = "assistance_requests"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    identity_id = Column(UUID(as_uuid=True), ForeignKey("identities.id"), nullable=False, index=True)

    encrypted_assistance_type = Column(LargeBinary, nullable=False)  # what kind of help is being asked for
    encrypted_situation_description = Column(LargeBinary, nullable=True)  # their situation, in their own words
    status = Column(String, nullable=False, default="new")  # new | approved | denied | in_progress | on_hold | completed | canceled

    applicant_acknowledged = Column(Boolean, nullable=False, default=False)
    acknowledged_date = Column(Date, nullable=True)

    # If someone helped the applicant complete the form
    encrypted_helper_name = Column(LargeBinary, nullable=True)
    encrypted_helper_contact = Column(LargeBinary, nullable=True)
    encrypted_helper_relationship = Column(LargeBinary, nullable=True)

    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    identity = relationship("Identity", back_populates="assistance_requests")
    activities = relationship("ActivityRecord", back_populates="assistance_request")
    documents = relationship("RequestDocument", back_populates="assistance_request")
    votes = relationship("RequestVote", back_populates="assistance_request")


class RequestDocument(Base):
    """
    A file attached to an AssistanceRequest (ID, pay stub, lease,
    etc.) — encrypted at rest the same way as every other PII field.
    Stored as bytes directly in Postgres, same pattern as the org
    logo, so it rides along with normal DB backups without needing a
    separate file-storage volume.
    """
    __tablename__ = "request_documents"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    assistance_request_id = Column(UUID(as_uuid=True), ForeignKey("assistance_requests.id"), nullable=False, index=True)
    filename = Column(String, nullable=False)
    content_type = Column(String, nullable=True)
    encrypted_file_data = Column(LargeBinary, nullable=False)
    uploaded_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    uploaded_at = Column(DateTime, default=datetime.utcnow)

    assistance_request = relationship("AssistanceRequest", back_populates="documents")


class ActivityAttachment(Base):
    """
    A receipt or invoice attached to a specific activity — encrypted at
    rest the same way as request documents. VOLUNTEER can see that
    attachments exist (a count) but never filenames or content;
    TEAMMEMBER/elevated ADMIN can view them in a popup.
    """
    __tablename__ = "activity_attachments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    activity_id = Column(UUID(as_uuid=True), ForeignKey("activity_records.id"), nullable=False, index=True)
    filename = Column(String, nullable=False)
    content_type = Column(String, nullable=True)
    encrypted_file_data = Column(LargeBinary, nullable=False)
    uploaded_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    uploaded_at = Column(DateTime, default=datetime.utcnow)

    activity = relationship("ActivityRecord", back_populates="attachments")


class RequestVote(Base):
    """
    One team member's Yes/No vote on whether to support an assistance
    request. One vote per (request, user) — voting again just updates
    the existing vote rather than creating a second one. Restricted to
    ADMIN/TEAMMEMBER, since a vote requires actually being able to see
    what's being voted on (DEACON/VOLUNTEER can't decrypt PII).
    """
    __tablename__ = "request_votes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    assistance_request_id = Column(UUID(as_uuid=True), ForeignKey("assistance_requests.id"), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    support = Column(Boolean, nullable=False)  # True = Yes/support, False = No
    voted_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    assistance_request = relationship("AssistanceRequest", back_populates="votes")


class MeetingNote(Base):
    """
    Team meeting minutes — two versions. The raw transcript is full
    PII, encrypted at rest and gated the same as any other PII
    (ADMIN/TEAMMEMBER only). The redacted transcript is stored as
    plain text, not encrypted — it's designed to contain no PII at
    all so DEACON (oversight) can read it. Date/time/location/summary/
    attendance are administrative, not client PII, so they're visible
    to every role regardless.
    """
    __tablename__ = "meeting_notes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    meeting_datetime = Column(DateTime, nullable=False)
    duration_minutes = Column(Integer, nullable=True)
    location = Column(String, nullable=True)
    summary = Column(Text, nullable=True)
    redacted_transcript = Column(Text, nullable=True)
    encrypted_raw_transcript = Column(LargeBinary, nullable=True)
    created_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    attendees = relationship("MeetingAttendance", back_populates="meeting")


class MeetingAttendance(Base):
    __tablename__ = "meeting_attendance"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    meeting_id = Column(UUID(as_uuid=True), ForeignKey("meeting_notes.id"), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)

    meeting = relationship("MeetingNote", back_populates="attendees")


class RecordPresence(Base):
    """
    One row per (identity, user) — a lightweight heartbeat, not a
    session log. Updated every ~15 seconds while someone has that
    recipient's page open. A row's presence is only meaningful if
    last_seen_at is recent (checked by the query, not by deleting old
    rows) — this is "is X currently looking at this," not history.
    """
    __tablename__ = "record_presence"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    identity_id = Column(UUID(as_uuid=True), ForeignKey("identities.id"), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    last_seen_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
