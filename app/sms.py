from app.config import settings


class SmsSendError(Exception):
    """Raised when an SMS genuinely fails to send."""
    pass


def send_sms(to_number: str, body: str) -> None:
    """
    No-op if Twilio isn't configured — callers should check
    settings.twilio_configured first if they want to distinguish
    'not configured' from 'sent'. This function itself just refuses
    silently rather than raising, since 'not configured' is expected
    and normal, not an error condition.
    """
    if not settings.twilio_configured:
        return

    from twilio.rest import Client
    from twilio.base.exceptions import TwilioRestException

    try:
        client = Client(settings.twilio_account_sid, settings.twilio_auth_token)
        client.messages.create(to=to_number, from_=settings.twilio_phone_number, body=body)
    except TwilioRestException as e:
        raise SmsSendError(f"Twilio failed to send: {e}")
