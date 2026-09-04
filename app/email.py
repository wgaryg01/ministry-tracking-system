import smtplib
from email.message import EmailMessage

from app.config import settings


def send_magic_link_email(to_email: str, link: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = "Your sign-in link"
    msg["From"] = settings.smtp_from
    msg["To"] = to_email
    msg.set_content(
        f"Click the link below to sign in. This link expires in 15 minutes "
        f"and can only be used once.\n\n{link}\n\n"
        f"If you didn't request this, you can safely ignore this email."
    )

    with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as server:
        server.starttls()
        server.login(settings.smtp_username, settings.smtp_password)
        server.send_message(msg)
