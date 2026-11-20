export const WORLDS = Object.freeze([
  "mirror_nebula",
  "starship_matrix",
  "liquid_prism",
  "data_constellation",
]);

export const GESTURE_STATES = Object.freeze({
  IDLE: "IDLE",
  TRACKING: "TRACKING",
  AIMING: "AIMING",
  TARGET_LOCKED: "TARGET_LOCKED",
  PRE_GRAB: "PRE_GRAB",
  GRABBED: "GRABBED",
  DRAGGING: "DRAGGING",
  PREVIEW_OPEN: "PREVIEW_OPEN",
  COOLDOWN: "COOLDOWN",
  TRACKING_LOST: "TRACKING_LOST",
});

const MESSAGE_TYPES = new Set([
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
]);

function smoothingAlpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

class LowPassFilter {
  constructor() {
    this.ready = false;
    this.value = 0;
  }

  next(value, alpha) {
    if (!this.ready) {
      this.ready = true;
      this.value = value;
      return value;
    }
    this.value = alpha * value + (1 - alpha) * this.value;
    return this.value;
  }

  reset() {
    this.ready = false;
    this.value = 0;
  }
}

export class OneEuroFilter {
  constructor({ minCutoff = 1.2, beta = 0.035, derivativeCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivativeCutoff = derivativeCutoff;
    this.signal = new LowPassFilter();
    this.derivative = new LowPassFilter();
    this.lastTime = null;
    this.lastRaw = null;
  }

  next(value, timeMs) {
    if (!Number.isFinite(value) || !Number.isFinite(timeMs)) return this.signal.value;
    if (this.lastTime === null || timeMs <= this.lastTime) {
      this.lastTime = timeMs;
      this.lastRaw = value;
      return this.signal.next(value, 1);
    }
    const dt = Math.min(.25, Math.max(.001, (timeMs - this.lastTime) / 1000));
    const rawDerivative = (value - this.lastRaw) / dt;
    const filteredDerivative = this.derivative.next(
      rawDerivative,
      smoothingAlpha(this.derivativeCutoff, dt),
    );
    const cutoff = this.minCutoff + this.beta * Math.abs(filteredDerivative);
    const filtered = this.signal.next(value, smoothingAlpha(cutoff, dt));
    this.lastTime = timeMs;
    this.lastRaw = value;
    return filtered;
  }

  reset() {
    this.signal.reset();
    this.derivative.reset();
    this.lastTime = null;
    this.lastRaw = null;
  }
}

export class GestureStateMachine {
  constructor({ grabThreshold = .28, releaseThreshold = .42, grabHoldMs = 100, cooldownMs = 560, lostMs = 500 } = {}) {
    this.config = { grabThreshold, releaseThreshold, grabHoldMs, cooldownMs, lostMs };
    this.state = GESTURE_STATES.IDLE;
    this.lockedToolId = null;
    this.grabbedToolId = null;
    this.since = 0;
    this.pinchSince = 0;
    this.cooldownUntil = 0;
    this.lastTrackingAt = 0;
  }

  update(input) {
    const now = Number(input.nowMs);
    const events = [];
    if (!input.tracking || input.confidence < .55) {
      if (this.lastTrackingAt && now - this.lastTrackingAt >= this.config.lostMs) {
        if (this.grabbedToolId) events.push({ type: "CANCEL_DRAG", toolId: this.grabbedToolId });
        this.state = GESTURE_STATES.TRACKING_LOST;
        this.grabbedToolId = null;
        this.lockedToolId = null;
      }
      return { state: this.state, events };
    }
    this.lastTrackingAt = now;
    if (now < this.cooldownUntil) {
      this.state = GESTURE_STATES.COOLDOWN;
      return { state: this.state, events };
    }

    const targetId = input.targetId || null;
    const pinch = Number(input.pinchDistance);
    if (this.state === GESTURE_STATES.TRACKING_LOST || this.state === GESTURE_STATES.IDLE || this.state === GESTURE_STATES.COOLDOWN) {
      this.state = GESTURE_STATES.TRACKING;
    }
    if (!this.grabbedToolId) {
      if (targetId) {
        if (this.lockedToolId !== targetId) {
          this.lockedToolId = targetId;
          this.since = now;
          this.pinchSince = 0;
          events.push({ type: "TARGET_LOCKED", toolId: targetId });
        }
        this.state = GESTURE_STATES.TARGET_LOCKED;
        if (pinch <= this.config.grabThreshold) {
          if (!this.pinchSince) this.pinchSince = now;
          this.state = GESTURE_STATES.PRE_GRAB;
          if (now - this.pinchSince >= this.config.grabHoldMs) {
            this.grabbedToolId = targetId;
            this.state = GESTURE_STATES.GRABBED;
            this.pinchSince = 0;
            events.push({ type: "GRAB_STARTED", toolId: targetId });
          }
        } else {
          this.pinchSince = 0;
        }
      } else {
        this.lockedToolId = null;
        this.pinchSince = 0;
        this.state = GESTURE_STATES.AIMING;
      }
      return { state: this.state, events };
    }

    if (pinch >= this.config.releaseThreshold) {
      const releasedId = this.grabbedToolId;
      this.grabbedToolId = null;
      this.lockedToolId = null;
      this.pinchSince = 0;
      this.cooldownUntil = now + this.config.cooldownMs;
      this.state = GESTURE_STATES.COOLDOWN;
      events.push({ type: "RELEASED", toolId: releasedId, point: input.point });
    } else {
      this.state = GESTURE_STATES.DRAGGING;
      events.push({ type: "DRAGGED", toolId: this.grabbedToolId, point: input.point });
    }
    return { state: this.state, events };
  }
}

export function validateSyncMessage(message, { sessionId, nowMs = Date.now(), lastSeq = -1 } = {}) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return { ok: false, reason: "shape" };
  const keys = Object.keys(message).sort().join(",");
  if (keys !== "payload,sent_at_ms,seq,session_id,source_id,type,version") return { ok: false, reason: "shape" };
  if (message.version !== 1 || message.session_id !== sessionId) return { ok: false, reason: "scope" };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(message.source_id)) return { ok: false, reason: "source" };
  if (!Number.isInteger(message.seq) || message.seq <= lastSeq) return { ok: false, reason: "replay" };
  if (!Number.isInteger(message.sent_at_ms) || Math.abs(nowMs - message.sent_at_ms) > 15000) return { ok: false, reason: "expired" };
  if (!MESSAGE_TYPES.has(message.type) || !message.payload || typeof message.payload !== "object" || Array.isArray(message.payload)) return { ok: false, reason: "type" };
  if (JSON.stringify(message.payload).length > 16000) return { ok: false, reason: "size" };
  return { ok: true, reason: "ok" };
}

export function chooseControllerCandidate({ selfId, candidateId, currentId = null, electionOpen = false }) {
  const values = [selfId, candidateId];
  if (electionOpen && currentId) values.push(currentId);
  return values.filter((value) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value || "")).sort()[0] || null;
}

export function initialState(overrides = {}) {
  return {
    world: "data_constellation",
    quality: "balanced",
    role: "controller",
    focusedToolId: null,
    previewToolId: null,
    visitorMode: false,
    camera: { permission: "prompt", active: false, error: null },
    gesture: { state: GESTURE_STATES.IDLE, confidence: 0, pointer: null },
    sync: { connected: true, controllerId: null, updatedAt: 0 },
    ...overrides,
  };
}

export function reduceState(state, action) {
  switch (action.type) {
    case "WORLD_CHANGED":
      return WORLDS.includes(action.world) ? { ...state, world: action.world } : state;
    case "QUALITY_CHANGED":
      return { ...state, quality: action.quality };
    case "FOCUS_CHANGED":
      return { ...state, focusedToolId: action.toolId || null };
    case "PREVIEW_CHANGED":
      return { ...state, previewToolId: action.toolId || null };
    case "CAMERA_CHANGED":
      return { ...state, camera: { ...state.camera, ...action.camera } };
    case "GESTURE_CHANGED":
      return { ...state, gesture: { ...state.gesture, ...action.gesture } };
    case "VISITOR_MODE_CHANGED":
      return { ...state, visitorMode: Boolean(action.enabled) };
    case "SYNC_SNAPSHOT":
      return {
        ...state,
        world: WORLDS.includes(action.snapshot.world) ? action.snapshot.world : state.world,
        focusedToolId: action.snapshot.focusedToolId || null,
        previewToolId: action.snapshot.previewToolId || null,
        sync: { ...state.sync, updatedAt: action.updatedAt || Date.now() },
      };
    default:
      return state;
  }
}

export function createStore(initial = initialState()) {
  let state = initial;
  const listeners = new Set();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduceState(state, action);
      if (next !== state) {
        state = next;
        listeners.forEach((listener) => listener(state, action));
      }
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
