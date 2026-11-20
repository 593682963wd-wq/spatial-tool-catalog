import { validateSyncMessage } from "./core.js";

export class MultiScreenSync {
  constructor({ sessionId, sourceId, role, websocketEnabled = false, csrf = "", apiBase = "" }) {
    this.sessionId = sessionId;
    this.sourceId = sourceId;
    this.role = role;
    this.websocketEnabled = websocketEnabled;
    this.csrf = csrf;
    this.apiBase = apiBase;
    this.seq = 0;
    this.lastSeq = new Map();
    this.channel = null;
    this.socket = null;
    this.listeners = new Set();
    this.snapshotProvider = () => ({});
    this.heartbeatTimer = null;
    this.controllerId = role === "controller" ? sourceId : null;
    this.lastSnapshotAt = 0;
    this.peers = new Map();
  }

  async start() {
    if ("BroadcastChannel" in window) {
      this.channel = new BroadcastChannel(`wd-ai-live-v1:${this.sessionId}`);
      this.channel.addEventListener("message", (event) => this.receive(event.data, "broadcast"));
    }
    if (this.websocketEnabled) await this.connectWebSocket();
    this.send("HELLO", { role: this.role });
    this.send("STATE_REQUEST", { role: this.role });
    this.heartbeatTimer = window.setInterval(() => {
      const now = Date.now();
      this.electController(now);
      const isController = this.controllerId === this.sourceId;
      this.send("HEARTBEAT", { role: isController ? "controller" : this.role, declared_role: this.role });
      if (isController && now - this.lastSnapshotAt >= 2000) {
        this.lastSnapshotAt = now;
        this.send("STATE_SNAPSHOT", this.snapshotProvider());
      }
    }, 1000);
  }

  electController(now = Date.now()) {
    for (const [source, peer] of this.peers) {
      if (now - peer.seenAt > 4500) this.peers.delete(source);
    }
    const candidates = [{ sourceId: this.sourceId, role: this.role }, ...[...this.peers].map(([sourceId, peer]) => ({ sourceId, role: peer.role }))];
    const originalControllers = candidates.filter((candidate) => candidate.role === "controller");
    const pool = originalControllers.length ? originalControllers : candidates;
    this.controllerId = pool.map((candidate) => candidate.sourceId).sort()[0] || this.sourceId;
    return this.controllerId;
  }

  async connectWebSocket() {
    try {
      const response = await fetch(`${this.apiBase}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AI-Live-CSRF": this.csrf },
        body: JSON.stringify({ session_id: this.sessionId }),
      });
      if (!response.ok) return;
      const data = await response.json();
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const params = new URLSearchParams({ session_id: this.sessionId });
      this.socket = new WebSocket(
        `${scheme}://${location.host}/tools/ai_live_interaction/ws?${params}`,
        ["wd-ai-live-v1", `wd-ai-live-auth.${data.token}`],
      );
      this.socket.addEventListener("message", (event) => {
        try { this.receive(JSON.parse(event.data), "websocket"); } catch { /* schema layer rejects non-JSON */ }
      });
    } catch {
      this.socket = null;
    }
  }

  setSnapshotProvider(provider) { this.snapshotProvider = provider; }
  onMessage(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  envelope(type, payload = {}) {
    this.seq += 1;
    return {
      version: 1,
      session_id: this.sessionId,
      source_id: this.sourceId,
      seq: this.seq,
      sent_at_ms: Date.now(),
      type,
      payload,
    };
  }

  send(type, payload = {}) {
    const message = this.envelope(type, payload);
    this.channel?.postMessage(message);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
    return message;
  }

  receive(message, transport) {
    const previous = this.lastSeq.get(message?.source_id) ?? -1;
    const verdict = validateSyncMessage(message, { sessionId: this.sessionId, lastSeq: previous });
    if (!verdict.ok || message.source_id === this.sourceId) return false;
    this.lastSeq.set(message.source_id, message.seq);
    if (message.type === "HELLO" || message.type === "HEARTBEAT") {
      const declaredRole = String(message.payload.declared_role || message.payload.role || "right");
      this.peers.set(message.source_id, { seenAt: Date.now(), role: declaredRole });
      this.electController();
    }
    if (message.type === "CONTROLLER_RELEASED") {
      this.peers.delete(message.source_id);
      this.electController();
    }
    if (message.type === "STATE_REQUEST" && this.controllerId === this.sourceId) this.send("STATE_SNAPSHOT", this.snapshotProvider());
    this.listeners.forEach((listener) => listener(message, transport));
    return true;
  }

  close() {
    this.send("CONTROLLER_RELEASED", { role: this.role });
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.channel?.close();
    this.socket?.close();
    this.channel = null;
    this.socket = null;
    this.listeners.clear();
  }
}
