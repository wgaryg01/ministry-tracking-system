from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

from app.config import settings

SESSION_COOKIE_NAME = "ministry_session"
SESSION_MAX_AGE_SECONDS = 60 * 60 * 12  # 12 hours

_serializer = URLSafeTimedSerializer(settings.secret_key, salt="session")


def create_session_token(user_id: str, role: str) -> str:
    return _serializer.dumps({"user_id": user_id, "role": role})


def read_session_token(token: str) -> dict | None:
    """Returns the session payload if valid and unexpired, else None."""
    try:
        return _serializer.loads(token, max_age=SESSION_MAX_AGE_SECONDS)
    except (BadSignature, SignatureExpired):
        return None
