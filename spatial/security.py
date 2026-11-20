from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlsplit

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer


TOOL_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$")
DISPLAY_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
ALLOWED_MESSAGE_TYPES = frozenset(
    {
        "HELLO",
        "HEARTBEAT",
        "STATE_REQUEST",
        "STATE_SNAPSHOT",
        "SCENE_CHANGED",
        "TOOL_FOCUSED",
        "TOOL_PREVIEWED",
        "TOOL_RELEASED",
        "POINTER_MOVED",
        "CONTROLLER_CLAIM",
        "CONTROLLER_RELEASED",
    }
)


def request_origin_matches(origin: str | None, host_url: str) -> bool:
    if not origin:
        return False
    expected = urlsplit(host_url)
    actual = urlsplit(origin)
    return (
        actual.scheme in {"http", "https"}
        and actual.scheme == expected.scheme
        and actual.netloc == expected.netloc
        and not actual.username
        and not actual.password
    )


def valid_tool_id(value: str) -> bool:
    return bool(TOOL_ID_RE.fullmatch(value or ""))


def sanitize_tool(raw: Mapping[str, Any]) -> dict[str, Any] | None:
    if not isinstance(raw, Mapping):
        raise TypeError("工具记录须为对象")
    tool_id = str(raw.get("id") or "").strip()
    if not valid_tool_id(tool_id) or tool_id == "ai_live_interaction":
        return None
    return {
        "id": tool_id,
        "name": str(raw.get("name") or tool_id)[:80],
        "category": str(raw.get("category") or "其他")[:40],
        "summary": str(raw.get("summary") or "暂无简介")[:240],
        "status": str(raw.get("status") or "standby")[:24],
        "access": str(raw.get("access") or "public")[:24],
    }


@dataclass(frozen=True)
class SignedTokenService:
    secret: str
    salt: str = "wd-ai-live-v1"

    def _serializer(self) -> URLSafeTimedSerializer:
        return URLSafeTimedSerializer(self.secret, salt=self.salt)

    def issue(self, purpose: str, subject: str, *, now_ms: int | None = None) -> str:
        return self._serializer().dumps(
            {
                "purpose": purpose,
                "subject": subject,
                "issued_at_ms": int(now_ms if now_ms is not None else time.time() * 1000),
                "version": 1,
            }
        )

    def verify(self, token: str, purpose: str, *, max_age_seconds: int) -> dict[str, Any] | None:
        try:
            payload = self._serializer().loads(token, max_age=max_age_seconds)
        except (BadSignature, SignatureExpired):
            return None
        if payload.get("purpose") != purpose or payload.get("version") != 1:
            return None
        return payload


def validate_sync_message(message: Any, *, session_id: str, now_ms: int | None = None) -> tuple[bool, str]:
    if not isinstance(message, dict):
        return False, "message_not_object"
    required = {"version", "session_id", "source_id", "seq", "sent_at_ms", "type", "payload"}
    if set(message) != required:
        return False, "message_shape"
    if message["version"] != 1 or message["session_id"] != session_id:
        return False, "message_scope"
    if not DISPLAY_ID_RE.fullmatch(str(message["source_id"])):
        return False, "source_id"
    if not isinstance(message["seq"], int) or message["seq"] < 0:
        return False, "seq"
    if message["type"] not in ALLOWED_MESSAGE_TYPES or not isinstance(message["payload"], dict):
        return False, "message_type"
    if len(str(message["payload"])) > 16_000:
        return False, "payload_too_large"
    current = int(now_ms if now_ms is not None else time.time() * 1000)
    if not isinstance(message["sent_at_ms"], int) or abs(current - message["sent_at_ms"]) > 15_000:
        return False, "message_expired"
    return True, "ok"
