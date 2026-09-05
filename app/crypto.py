import hashlib
import hmac

from cryptography.fernet import Fernet

from app.config import settings

_fernet = Fernet(settings.pii_encryption_key.encode())


def encrypt_field(plaintext: str) -> bytes:
    if plaintext is None:
        return None
    return _fernet.encrypt(plaintext.encode())


def decrypt_field(ciphertext: bytes) -> str:
    """
    Only call this from code paths gated to ADMIN / CASEWORKER roles.
    """
    if ciphertext is None:
        return None
    return _fernet.decrypt(ciphertext).decode()


def blind_index(value: str) -> str:
    """
    Deterministic HMAC of a normalized value (e.g. lowercased full name
    or digits-only phone number) so records can be searched/matched
    without decrypting the whole table. Uses the same key material —
    in production consider a separate HMAC key from the Fernet key.
    """
    normalized = value.strip().lower().encode()
    return hmac.new(settings.pii_encryption_key.encode(), normalized, hashlib.sha256).hexdigest()


def encrypt_bytes(data: bytes) -> bytes:
    """For binary payloads (document uploads) — no str encode/decode assumption."""
    if data is None:
        return None
    return _fernet.encrypt(data)


def decrypt_bytes(ciphertext: bytes) -> bytes:
    if ciphertext is None:
        return None
    return _fernet.decrypt(ciphertext)


def encode_checklist(values: list[str], other_text: str | None = None) -> str | None:
    """
    Joins a multi-select checkbox field (e.g. employment status,
    referral source) into one string for encrypted storage. "other"
    gets its free-text folded in as "other:<text>".
    """
    if not values:
        return None
    parts = []
    for v in values:
        if v == "other" and other_text:
            parts.append(f"other:{other_text}")
        else:
            parts.append(v)
    return "|".join(parts)


def decode_checklist(joined: str | None) -> list[str]:
    if not joined:
        return []
    return joined.split("|")
