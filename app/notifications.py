from datetime import datetime, timedelta

from app.db import SessionLocal
from app.models import NotificationRule, ActivityRecord, ActivityAssignment, User, Identity, NotificationSend
from app.crypto import decrypt_field
from app.email import send_notification_email, EmailSendError
from app.sms import send_sms, SmsSendError
from app.config import settings


def format_offset(minutes: int) -> str:
    if minutes >= 7 * 24 * 60 and minutes % (7 * 24 * 60) == 0:
        weeks = minutes // (7 * 24 * 60)
        return f"{weeks} week{'s' if weeks != 1 else ''} before"
    if minutes >= 24 * 60 and minutes % (24 * 60) == 0:
        days = minutes // (24 * 60)
        return f"{days} day{'s' if days != 1 else ''} before"
    if minutes >= 60 and minutes % 60 == 0:
        hours = minutes // 60
        return f"{hours} hour{'s' if hours != 1 else ''} before"
    return f"{minutes} minute{'s' if minutes != 1 else ''} before"


def _already_sent(db, rule_id, user_id, channel) -> bool:
    return (
        db.query(NotificationSend)
        .filter_by(notification_rule_id=rule_id, user_id=user_id, channel=channel)
        .first()
        is not None
    )


def send_due_notifications() -> None:
    """
    Runs frequently (every few minutes). For every notification rule
    attached to a still-scheduled activity, checks whether its offset
    window has arrived and — if so — notifies each assigned team
    member via whichever channels they've opted into, exactly once
    per (rule, recipient, channel), tracked in NotificationSend.
    """
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        rules = (
            db.query(NotificationRule, ActivityRecord)
            .join(ActivityRecord, NotificationRule.activity_id == ActivityRecord.id)
            .filter(ActivityRecord.status == "scheduled", ActivityRecord.scheduled_at.isnot(None))
            .all()
        )

        for rule, activity in rules:
            due_at = activity.scheduled_at - timedelta(minutes=rule.offset_minutes)
            if now < due_at:
                continue

            assignments = db.query(ActivityAssignment).filter(ActivityAssignment.activity_id == activity.id).all()
            if not assignments:
                continue

            identity = db.query(Identity).filter(Identity.id == activity.identity_id).first()
            person_label = decrypt_field(identity.encrypted_full_name) if identity else "a person"
            offset_label = format_offset(rule.offset_minutes)
            when = activity.scheduled_at.strftime("%b %d, %Y at %I:%M %p")
            subject = f"Reminder: scheduled activity {offset_label}"
            body = f"You're assigned to a scheduled activity for {person_label}, coming up {offset_label} ({when})."

            for a in assignments:
                user = db.query(User).filter(User.id == a.user_id).first()
                if not user:
                    continue

                if user.notify_email and not _already_sent(db, rule.id, user.id, "email"):
                    try:
                        send_notification_email(user.email, subject, body)
                        db.add(NotificationSend(notification_rule_id=rule.id, user_id=user.id, channel="email", status="sent"))
                    except EmailSendError as e:
                        db.add(NotificationSend(notification_rule_id=rule.id, user_id=user.id, channel="email", status="failed", error_detail=str(e)))
                    db.commit()

                if user.notify_sms and settings.twilio_configured and user.phone_number and not _already_sent(db, rule.id, user.id, "sms"):
                    try:
                        send_sms(user.phone_number, body)
                        db.add(NotificationSend(notification_rule_id=rule.id, user_id=user.id, channel="sms", status="sent"))
                    except SmsSendError as e:
                        db.add(NotificationSend(notification_rule_id=rule.id, user_id=user.id, channel="sms", status="failed", error_detail=str(e)))
                    db.commit()
    finally:
        db.close()
