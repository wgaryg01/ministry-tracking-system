from datetime import date, datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.db import SessionLocal
from app.models import User
from app.auth import issue_magic_link
from app.audit import log_audit_event
from app.email import EmailSendError
from app.sms import SmsSendError
from app.notifications import send_due_notifications


def send_pending_term_invitations() -> None:
    """
    Runs daily at 8am. Finds any TEAMMEMBER whose term starts today and
    who hasn't been sent their invitation yet, and sends it now.
    """
    db = SessionLocal()
    try:
        today = date.today()
        pending = (
            db.query(User)
            .filter(
                User.term_start_date == today,
                User.invitation_sent_at.is_(None),
            )
            .all()
        )
        for user in pending:
            try:
                issue_magic_link(db, user, invitation=True, also_sms=bool(user.phone_number))
                user.invitation_sent_at = datetime.utcnow()
                db.commit()
                log_audit_event(db, None, "scheduled_invitation_sent", resource_type="user", resource_id=user.id)
            except (EmailSendError, SmsSendError) as e:
                log_audit_event(
                    db, None, "scheduled_invitation_failed",
                    resource_type="user", resource_id=user.id, details=str(e),
                )
    finally:
        db.close()


def start_scheduler() -> BackgroundScheduler:
    """
    NOTE: runs at 8:00 in the container's local timezone, which is UTC
    by default. Set the TZ environment variable on the app container
    (e.g. TZ=America/Chicago) if you want this to mean 8am local time.
    """
    scheduler = BackgroundScheduler()
    scheduler.add_job(send_pending_term_invitations, CronTrigger(hour=8, minute=0))
    scheduler.add_job(send_due_notifications, IntervalTrigger(minutes=5))
    scheduler.start()
    return scheduler
