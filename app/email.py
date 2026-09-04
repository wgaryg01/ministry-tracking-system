import smtplib
from email.message import EmailMessage

from app.config import settings


class EmailSendError(Exception):
    """Raised when an email genuinely fails to send (bad recipient, auth failure, etc.)."""
    pass


def send_notification_email(to_email: str, subject: str, body: str) -> None:
    _send(to_email, subject=subject, body=body)


def send_magic_link_email(to_email: str, link: str) -> None:
    _send(
        to_email,
        subject="Your sign-in link",
        body=(
            f"Click the link below to sign in. This link expires in 15 minutes "
            f"and can only be used once.\n\n{link}\n\n"
            f"If you didn't request this, you can safely ignore this email."
        ),
    )


def send_invitation_email(to_email: str, link: str) -> None:
    _send(
        to_email,
        subject="You've been added to the ministry tracking system",
        body=(
            f"You've been given access to the ministry tracking system. "
            f"Click the link below to sign in for the first time. This link "
            f"expires in 15 minutes and can only be used once — you'll request "
            f"a new one each time you sign in going forward.\n\n{link}"
        ),
    )


def _send(to_email: str, subject: str, body: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = settings.smtp_from
    msg["To"] = to_email
    msg.set_content(body)

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as server:
            server.starttls()
            server.login(settings.smtp_username, settings.smtp_password)
            server.send_message(msg)
    except smtplib.SMTPRecipientsRefused:
        raise EmailSendError(f"The mail server rejected the recipient address: {to_email}")
    except smtplib.SMTPAuthenticationError:
        raise EmailSendError("SMTP authentication failed — check SMTP_USERNAME/SMTP_PASSWORD")
    except smtplib.SMTPException as e:
        raise EmailSendError(f"Failed to send email: {e}")
