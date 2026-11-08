"""Accounts: password hashing, signed session tokens and the user store.

Users are kept in a small Qdrant collection (the same cluster the documents use), so they survive
restarts and redeploys of a host with a throwaway disk. No extra service is needed.
"""
import base64
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
import uuid

USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,23}$")
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128
TOKEN_TTL_SECONDS = 30 * 24 * 3600  # sessions last 30 days
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2**14, 8, 1


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def normalize_username(username: str) -> str:
    return (username or "").strip().lower()


def validate_credentials(username: str, password: str) -> str | None:
    """Return a user-facing problem with the credentials, or None when they are acceptable."""
    if not USERNAME_RE.match(username):
        return "Usernames are 3 to 24 characters: letters, numbers, - or _."
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Use at least {MIN_PASSWORD_LENGTH} characters for the password."
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"Use at most {MAX_PASSWORD_LENGTH} characters for the password."
    return None


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=32)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = _unb64(digest)
        actual = hashlib.scrypt(
            password.encode("utf-8"), salt=_unb64(salt), n=int(n), r=int(r), p=int(p), dklen=len(expected)
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


# Checked when the username does not exist, so a wrong username and a wrong password take equally long.
DUMMY_HASH = hash_password("not-a-real-password")


class TokenSigner:
    """Stateless session tokens: base64(payload).base64(HMAC-SHA256(secret, payload))."""

    def __init__(self, secret: bytes):
        self._secret = secret

    def sign(self, username: str, ttl_seconds: int = TOKEN_TTL_SECONDS) -> str:
        payload = _b64(json.dumps({"u": username, "exp": int(time.time()) + ttl_seconds}, separators=(",", ":")).encode())
        signature = _b64(hmac.new(self._secret, payload.encode("ascii"), hashlib.sha256).digest())
        return f"{payload}.{signature}"

    def verify(self, token: str) -> str | None:
        try:
            payload, signature = token.split(".")
            expected = _b64(hmac.new(self._secret, payload.encode("ascii"), hashlib.sha256).digest())
            if not hmac.compare_digest(signature, expected):
                return None
            data = json.loads(_unb64(payload))
            if int(data["exp"]) < time.time():
                return None
            return str(data["u"])
        except (ValueError, KeyError, TypeError):
            return None


class UserStore:
    """Users and their workspace lists, stored as points in a small Qdrant collection."""

    CACHE_SECONDS = 30

    def __init__(self, get_client, collection: str):
        self._get_client = get_client
        self.collection = collection
        self._ready = False
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[float, dict | None]] = {}

    @staticmethod
    def _point_id(username: str) -> str:
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"easylm-user:{username}"))

    def _client(self):
        client = self._get_client()
        if not self._ready:
            from qdrant_client.models import Distance, VectorParams

            if not client.collection_exists(collection_name=self.collection):
                # a Qdrant collection needs a vector; users only use the payload
                client.create_collection(
                    collection_name=self.collection, vectors_config=VectorParams(size=1, distance=Distance.DOT)
                )
            self._ready = True
        return client

    def get(self, username: str) -> dict | None:
        now = time.time()
        with self._lock:
            cached = self._cache.get(username)
            if cached and now - cached[0] < self.CACHE_SECONDS:
                return cached[1]
        found = self._client().retrieve(
            collection_name=self.collection, ids=[self._point_id(username)], with_payload=True
        )
        record = dict(found[0].payload) if found else None
        with self._lock:
            self._cache[username] = (now, record)
        return record

    def create(self, username: str, password_hash: str) -> dict:
        from qdrant_client.models import PointStruct

        record = {
            "username": username,
            "password_hash": password_hash,
            "created": int(time.time()),
            "workspaces": [{"n": 1, "name": "Workspace 1"}],
        }
        self._client().upsert(
            collection_name=self.collection,
            points=[PointStruct(id=self._point_id(username), vector=[1.0], payload=record)],
            wait=True,
        )
        with self._lock:
            self._cache.pop(username, None)
        return record

    def set_workspaces(self, username: str, workspaces: list[dict]):
        self._client().set_payload(
            collection_name=self.collection,
            payload={"workspaces": workspaces},
            points=[self._point_id(username)],
            wait=True,
        )
        with self._lock:
            self._cache.pop(username, None)
