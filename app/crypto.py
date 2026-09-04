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
