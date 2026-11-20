from __future__ import annotations

import json
import os
import secrets
import time
from collections.abc import Callable, Iterable, Mapping
from typing import Any
from urllib.parse import quote

from flask import Blueprint, Response, current_app, jsonify, make_response, render_template, request

from .security import SignedTokenService, request_origin_matches, sanitize_tool, valid_tool_id


CatalogProvider = Callable[[], Iterable[Mapping[str, Any]]]
LaunchCallback = Callable[[str], Response | tuple[Any, int] | Any]


def create_ai_live_blueprint(
    *,
    catalog_provider: CatalogProvider,
    launch_callback: LaunchCallback | None = None,
) -> Blueprint:
    blueprint = Blueprint("ai_live_clean", __name__, url_prefix="/tools/ai_live_interaction")
    launch_enabled = launch_callback is not None
    catalog_snapshot: dict[str, Any] = {"loaded_at": 0.0, "tools": []}
    catalog_ttl_seconds = 8.0

    def tokens() -> SignedTokenService:
        secret = str(current_app.config["AI_LIVE_SECRET"])
        return SignedTokenService(secret)

    @blueprint.before_request
    def require_enabled() -> Response | None:
        if current_app.config.get("AI_LIVE_ENABLED", True):
            return None
        if "/api/" in request.path or request.path.endswith("/healthz"):
            return jsonify({"ok": False, "error": "ai_live_disabled"}), 404
        return Response("AI 实景交互功能未启用。\n", status=404, mimetype="text/plain")

    def catalog() -> list[dict[str, Any]]:
        now = time.monotonic()
        cached = catalog_snapshot["tools"]
        if cached and now - float(catalog_snapshot["loaded_at"]) < catalog_ttl_seconds:
            return cached
        output: list[dict[str, Any]] = []
        seen: set[str] = set()
        for raw in catalog_provider():
            tool = sanitize_tool(raw)
            if not tool or tool["id"] in seen:
                continue
            seen.add(tool["id"])
            output.append(tool)
        # The Tool Hub catalog includes live runtime state and is comparatively
        # expensive to serialize. Reuse one short-lived snapshot across the
        # catalog -> preview -> launch golden path. The launch callback still
        # performs the authoritative registry and permission checks.
        catalog_snapshot["loaded_at"] = now
        catalog_snapshot["tools"] = output
        return output

    def reject_cross_origin() -> Response | None:
        if not request_origin_matches(request.headers.get("Origin"), request.host_url):
            return jsonify({"ok": False, "error": "origin_rejected"}), 403
        return None

    def verify_csrf(*, require_cookie: bool = True) -> Response | None:
        header = request.headers.get("X-AI-Live-CSRF", "")
        cookie = request.cookies.get("ai_live_csrf", "")
        if not header or (require_cookie and not secrets.compare_digest(header, cookie)):
            return jsonify({"ok": False, "error": "csrf_rejected"}), 403
        if not tokens().verify(header, "csrf", max_age_seconds=3600):
            return jsonify({"ok": False, "error": "csrf_expired"}), 403
        return None

    @blueprint.get("/")
    def experience() -> Response:
        role = request.args.get("role", "controller")
        if role not in {"controller", "left", "center", "right"}:
            role = "controller"
        display_id = request.args.get("display", role)
        if not display_id.replace("-", "").replace("_", "").isalnum():
            display_id = role
        csrf_token = tokens().issue("csrf", secrets.token_hex(8))
        config = {
            "apiBase": "/tools/ai_live_interaction/api",
            "assetBase": "/static",
            "role": role,
            "displayId": display_id[:64],
            "csrf": csrf_token,
            "gestureModel": "/static/vendor/mediapipe/models/gesture_recognizer.task",
            "gestureWasm": "/static/vendor/mediapipe/wasm",
            "visionModule": "/static/vendor/mediapipe/vision_bundle.js",
            "websocketEnabled": bool(current_app.config.get("AI_LIVE_WEBSOCKET_ENABLED")),
            "launchEnabled": launch_enabled,
        }
        response = make_response(
            render_template(
                "ai_live_interaction_clean.html",
                ai_live_config=json.dumps(config, ensure_ascii=False).replace("<", "\\u003c"),
                hub_home=os.environ.get("TOOL_HUB_HOME", "/"),
            )
        )
        response.set_cookie(
            "ai_live_csrf",
            csrf_token,
            secure=request.is_secure,
            httponly=False,
            samesite="Strict",
            max_age=3600,
            path="/tools/ai_live_interaction/",
        )
        response.headers["Cache-Control"] = "no-store, private"
        return response

    @blueprint.get("/api/tools")
    def tools_api() -> Response:
        return jsonify({"ok": True, "tools": catalog()})

    @blueprint.get("/api/tools/<tool_id>/preview")
    def preview_api(tool_id: str) -> Response:
        match = next((tool for tool in catalog() if tool["id"] == tool_id), None)
        if not match:
            return jsonify({"ok": False, "error": "tool_not_allowed"}), 404
        return jsonify(
            {
                "ok": True,
                "preview": {
                    "tool": match,
                    "kind": "summary",
                    "updatedAt": None,
                    "message": (
                        "当前显示注册表只读摘要；确认后才会调用原工具启动权限链路。"
                        if launch_enabled
                        else "示例目录仅供浏览，未连接可启动的工具。"
                    ),
                },
            }
        )

    @blueprint.post("/api/session")
    def session_api() -> Response:
        # Simultaneously opened displays share one cookie jar, so another
        # display can rotate the double-submit cookie after this page renders.
        # Session bootstrap still requires a valid signed token and same origin;
        # tool launch keeps strict header/cookie equality.
        blocked = reject_cross_origin() or verify_csrf(require_cookie=False)
        if blocked:
            return blocked
        payload = request.get_json(silent=True) or {}
        session_id = str(payload.get("session_id") or "")
        if len(session_id) < 8 or len(session_id) > 80 or not session_id.replace("-", "").isalnum():
            return jsonify({"ok": False, "error": "invalid_session"}), 400
        return jsonify(
            {
                "ok": True,
                "session_id": session_id,
                "token": tokens().issue("websocket", session_id),
                "expiresIn": 900,
            }
        )

    @blueprint.post("/api/tools/<tool_id>/launch")
    def launch_api(tool_id: str) -> Response:
        blocked = reject_cross_origin() or verify_csrf()
        if blocked:
            return blocked
        if not valid_tool_id(tool_id) or not any(tool["id"] == tool_id for tool in catalog()):
            return jsonify({"ok": False, "error": "tool_not_allowed"}), 404
        payload = request.get_json(silent=True) or {}
        if payload.get("confirmed") is not True:
            return jsonify({"ok": False, "error": "confirmation_required"}), 409
        if payload.get("visitor_mode") is True:
            return jsonify({"ok": False, "error": "visitor_mode_read_only"}), 403
        if launch_callback is None:
            return jsonify(
                {
                    "ok": False,
                    "error": "launch_unavailable_in_standalone",
                    "message": "示例目录仅供浏览，未连接可启动的工具。",
                }
            ), 503
        result = launch_callback(tool_id)
        status_code = 200
        response = result
        if isinstance(result, tuple):
            response, status_code = result[0], int(result[1])
        data = response.get_json(silent=True) if hasattr(response, "get_json") else {}
        data = data if isinstance(data, dict) else {}
        launched = bool(data.get("ok")) and status_code < 400
        safe_payload: dict[str, Any] = {
            "ok": launched,
            "message": (
                "工具已提交给工具台启动。"
                if launched
                else "工具台未完成启动，请返回工具台查看状态。"
            ),
        }
        if launched:
            safe_payload["open_path"] = f"/open-tool/{quote(tool_id, safe='')}"
        return jsonify(safe_payload), status_code

    @blueprint.get("/healthz")
    def healthz() -> Response:
        return jsonify(
            {
                "ok": True,
                "service": "ai_live_interaction",
                "camera": "browser_local_only",
                "launch_mode": "integrated" if launch_enabled else "preview_only",
                "version": "1",
            }
        )

    @blueprint.after_request
    def security_headers(response: Response) -> Response:
        response.headers["Content-Security-Policy"] = "; ".join(
            [
                "default-src 'self'",
                "script-src 'self'",
                "style-src 'self'",
                "img-src 'self' data: blob:",
                "media-src 'self' blob:",
                "connect-src 'self'",
                "worker-src 'self'",
                "object-src 'none'",
                "base-uri 'self'",
                "form-action 'self'",
                "frame-ancestors 'self'",
            ]
        )
        response.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin-allow-popups"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    return blueprint
