import { CameraController } from "./camera.js";
import { createStore, GestureStateMachine, OneEuroFilter, initialState } from "./core.js";
import { SceneRenderer } from "./scene.js";
import { MultiScreenSync } from "./sync.js";

const root = document.querySelector("[data-ai-live-root]");
if (!root) throw new Error("AI live root missing");

const config = JSON.parse(document.querySelector("#ai-live-config")?.textContent || "{}");
const stage = root.querySelector("[data-stage]");
const toolSpace = root.querySelector("[data-tool-space]");
const consentPanel = root.querySelector("[data-consent-panel]");
const video = root.querySelector("[data-camera-video]");
const previewPanel = root.querySelector("[data-preview-panel]");
const lensContent = root.querySelector("[data-lens-content]");
const lensLoading = root.querySelector("[data-lens-loading]");
const emptyState = root.querySelector("[data-empty-state]");
const pointer = root.querySelector("[data-gesture-pointer]");
const impact = root.querySelector("[data-confirm-flash]");
const categoryRail = root.querySelector("[data-category-rail]");
const settingsPanel = root.querySelector("[data-hud]");
const searchInput = root.querySelector("[data-tool-search]");
const searchResults = root.querySelector("[data-search-results]");
const bridgePath = root.querySelector("[data-bridge-path]");
const bridgeShadow = root.querySelector("[data-bridge-shadow]");
const bridgeSource = root.querySelector("[data-bridge-source]");
const bridgePulse = root.querySelector("[data-bridge-pulse]");
const bridgeTarget = root.querySelector("[data-bridge-target]");
const bridgeMotions = [...root.querySelectorAll("[data-bridge-motion]")];
const holoAnchor = root.querySelector("[data-holo-anchor]");
const handOcclusionCanvas = root.querySelector("[data-hand-occlusion]");
const handOcclusionContext = handOcclusionCanvas?.getContext("2d", { alpha: true });
const role = config.role || "controller";
root.dataset.role = role;

const query = new URLSearchParams(location.search);
const sessionId = query.get("session") || crypto.randomUUID();
if (!query.has("session")) {
  query.set("session", sessionId);
  history.replaceState(null, "", `${location.pathname}?${query}${location.hash}`);
}

const displayPrefix = String(config.displayId || role).replace(/[^A-Za-z0-9_-]/g, "").replace(/^[^A-Za-z0-9]+/, "").slice(0, 55) || "display";
const sourceId = `${displayPrefix}-${crypto.randomUUID().slice(0, 8)}`;
const store = createStore(initialState({ role }));
const filters = { x: new OneEuroFilter(), y: new OneEuroFilter() };
const gestureMachine = new GestureStateMachine({ grabHoldMs: 110, cooldownMs: 520, lostMs: 500 });
const toolNodes = new Map();
const reducedMotionQuery = matchMedia("(prefers-reduced-motion: reduce)");
const compactViewportQuery = matchMedia("(max-width: 760px)");

let tools = [];
let visibleTools = [];
let activeCategory = "全部";
let focusedIndex = -1;
let catalogIsFixture = false;
let catalogRequest = 0;
let previewRequest = 0;
let hoverTimer = 0;
let wheelTimer = 0;
let visitorTimer = 0;
let visitorResumeTimer = 0;
let gestureConfirmSince = 0;
let gestureConfirmFired = false;
let latestGestureMs = 0;
let lastInteractionPoint = { x: innerWidth * .48, y: innerHeight * .54 };
let metrics = { fps: 0, frameMs: 0, renderer: "initializing" };
let handTrackingActive = false;
let handLostTimer = 0;

function q(selector) {
  return root.querySelector(selector);
}

function text(selector, value) {
  root.querySelectorAll(selector).forEach((element) => {
    element.textContent = value;
  });
}

function toolGlyph(tool) {
  if (!tool) return "+";
  const category = String(tool.category || "");
  const pairs = [
    ["航空运行", "航"],
    ["气象", "气"],
    ["安全", "安"],
    ["报告", "报"],
    ["排班", "班"],
    ["AI", "AI"],
    ["办公", "办"],
    ["个人", "我"],
  ];
  const matched = pairs.find(([keyword]) => category.includes(keyword) || String(tool.name || "").includes(keyword));
  if (matched) return matched[1];
  const clean = Array.from(String(tool.name || "AI").replace(/[\s·._-]+/g, ""));
  return clean[0] || "AI";
}

const SVG_NS = "http://www.w3.org/2000/svg";
const TOOL_ICON_PATHS = {
  document: ["M7 3.5h7l4 4v13H7z", "M14 3.5v4h4", "M10 12h5", "M10 15.5h5"],
  chart: ["M5 19V10h3v9", "M10.5 19V5h3v14", "M16 19v-7h3v7", "M4 20.5h16"],
  pie: ["M12 3v9h9A9 9 0 0 0 12 3Z", "M9.5 5.3A8 8 0 1 0 18.7 14H9.5Z"],
  people: ["M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M15.5 10a2.4 2.4 0 1 0 0-4.8", "M3.8 19c.5-3.1 2.2-4.8 5.2-4.8s4.7 1.7 5.2 4.8", "M14 14.8c3.4-.6 5.5.8 6.2 4.2"],
  waveform: ["M3 12h2l1.4-5 2.3 10 2.2-13 2.4 16 2.1-11 1.7 6 1.2-3H21"],
  terminal: ["m5 7 5 5-5 5", "M12.5 18H20"],
  cloud: ["M6.2 18h11.2a3.6 3.6 0 0 0 .4-7.2A5.8 5.8 0 0 0 6.9 9.3 4.4 4.4 0 0 0 6.2 18Z"],
  shield: ["M12 3 5.5 6v5.1c0 4.4 2.7 7.7 6.5 9.9 3.8-2.2 6.5-5.5 6.5-9.9V6Z", "m9.2 12 1.8 1.8 4-4"],
  sparkle: ["M12 3.2 13.7 9l5.8 1.7-5.8 1.7-1.7 5.8-1.7-5.8-5.8-1.7L10.3 9Z"],
};

function toolIconKind(tool) {
  const label = `${tool?.category || ""} ${tool?.name || ""}`;
  if (/日报|报告|总结|文档|收文|资料/.test(label)) return "document";
  if (/统计|指标|趋势|品质|评价/.test(label)) return "chart";
  if (/分析|评估|计划|时刻/.test(label)) return "pie";
  if (/人员|排班|空勤|协同|部门/.test(label)) return "people";
  if (/语音|音频|讲解|助手/.test(label)) return "waveform";
  if (/命令|终端|自动化|脚本/.test(label)) return "terminal";
  if (/气象|天气|雷达/.test(label)) return "cloud";
  if (/安全|风险|预警|维修/.test(label)) return "shield";
  return "sparkle";
}

function createToolIcon(tool) {
  const kind = toolIconKind(tool);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("wd-ai-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.dataset.icon = kind;
  (TOOL_ICON_PATHS[kind] || TOOL_ICON_PATHS.sparkle).forEach((definition) => {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", definition);
    svg.append(path);
  });
  return svg;
}

function renderToolIcon(element, tool) {
  if (!element) return;
  element.replaceChildren(createToolIcon(tool));
  element.dataset.icon = toolIconKind(tool);
}

function toolTone(tool) {
  const category = `${tool?.category || ""} ${tool?.name || ""}`;
  if (/气象|天气|雷达/.test(category)) return "cyan";
  if (/安全|风险|预警|维修/.test(category)) return "amber";
  if (/报告|日报|总结|文档/.test(category)) return "gold";
  if (/排班|人员|办公|协同/.test(category)) return "silver";
  return "graphite";
}

function humanToolStatus(status) {
  const labels = {
    running: "运行中",
    starting: "启动中",
    stale: "端口异常",
    stopped: "未启动",
    ready: "可用",
    standby: "待命",
  };
  return labels[String(status || "").toLowerCase()] || "待命";
}

function setCoach(step, title, message) {
  text("[data-coach-step]", step);
  text("[data-coach-title]", title);
  text("[data-coach-message]", message);
}

function announce(value) {
  text("[data-live-announcer]", value);
}

function setStatus(selector, value, tone = "gray") {
  const element = q(selector);
  if (!element) return;
  element.textContent = value;
  element.className = `wd-badge wd-badge--${tone}`;
}

function setExperienceState(state) {
  root.dataset.state = state;
}

function visibleToolIds() {
  return visibleTools.map((tool) => tool.id);
}

function currentTool() {
  const id = store.getState().focusedToolId;
  return tools.find((tool) => tool.id === id) || visibleTools[focusedIndex] || null;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function resizeHandOcclusion() {
  if (!handOcclusionCanvas || !handOcclusionContext) return;
  const rect = stage.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (handOcclusionCanvas.width !== width || handOcclusionCanvas.height !== height) {
    handOcclusionCanvas.width = width;
    handOcclusionCanvas.height = height;
  }
}

function convexHull(points) {
  if (points.length < 3) return points;
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (origin, a, b) => (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  const lower = [];
  sorted.forEach((point) => {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  });
  const upper = [];
  [...sorted].reverse().forEach((point) => {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  });
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function clearHandOcclusion() {
  if (!handOcclusionContext || !handOcclusionCanvas) return;
  handOcclusionContext.clearRect(0, 0, handOcclusionCanvas.width, handOcclusionCanvas.height);
}

function drawMirroredVideoCover(context, destinationWidth, destinationHeight) {
  if (!video?.videoWidth || !video?.videoHeight) return;
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const scale = Math.max(destinationWidth / sourceWidth, destinationHeight / sourceHeight);
  const cropWidth = destinationWidth / scale;
  const cropHeight = destinationHeight / scale;
  const cropX = (sourceWidth - cropWidth) / 2;
  const cropY = (sourceHeight - cropHeight) / 2;
  context.save();
  context.translate(destinationWidth, 0);
  context.scale(-1, 1);
  context.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, destinationWidth, destinationHeight);
  context.restore();
}

function mapVideoPointToStage(point) {
  const normalized = {
    x: clamp(Number(point?.x || 0), 0, 1),
    y: clamp(Number(point?.y || 0), 0, 1),
  };
  if (!video?.videoWidth || !video?.videoHeight) return normalized;
  const rect = stage.getBoundingClientRect();
  const stageAspect = rect.width / Math.max(1, rect.height);
  const videoAspect = video.videoWidth / Math.max(1, video.videoHeight);
  if (videoAspect > stageAspect) {
    const visibleWidth = stageAspect / videoAspect;
    normalized.x = (normalized.x - (1 - visibleWidth) / 2) / visibleWidth;
  } else if (videoAspect < stageAspect) {
    const visibleHeight = videoAspect / stageAspect;
    normalized.y = (normalized.y - (1 - visibleHeight) / 2) / visibleHeight;
  }
  normalized.x = clamp(normalized.x, 0, 1);
  normalized.y = clamp(normalized.y, 0, 1);
  return normalized;
}

function drawHandOcclusion(landmarks, palmScale = 0) {
  if (!handOcclusionCanvas || !handOcclusionContext || !camera.stream || !Array.isArray(landmarks) || landmarks.length < 8) {
    clearHandOcclusion();
    return;
  }
  resizeHandOcclusion();
  const width = handOcclusionCanvas.width;
  const height = handOcclusionCanvas.height;
  const padding = clamp(Number(palmScale || 0) * height * .2, 4, 16);
  const pointCloud = [];
  landmarks.forEach((landmark) => {
    const mapped = mapVideoPointToStage(landmark);
    const x = mapped.x * width;
    const y = mapped.y * height;
    pointCloud.push(
      { x: x - padding, y },
      { x: x + padding, y },
      { x, y: y - padding },
      { x, y: y + padding },
    );
  });
  const hull = convexHull(pointCloud);
  if (hull.length < 3) return;
  handOcclusionContext.clearRect(0, 0, width, height);
  handOcclusionContext.save();
  handOcclusionContext.beginPath();
  handOcclusionContext.moveTo(hull[0].x, hull[0].y);
  hull.slice(1).forEach((point) => handOcclusionContext.lineTo(point.x, point.y));
  handOcclusionContext.closePath();
  handOcclusionContext.clip();
  drawMirroredVideoCover(handOcclusionContext, width, height);
  handOcclusionContext.restore();
}

function setSpatialParallax(x, y) {
  const normalizedX = clamp((x - .5) * 2, -1, 1);
  const normalizedY = clamp((y - .5) * 2, -1, 1);
  stage.style.setProperty("--parallax-x", normalizedX.toFixed(3));
  stage.style.setProperty("--parallax-y", normalizedY.toFixed(3));
  if (!holoAnchor) return;
  const rect = holoAnchor.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  const clientX = stageRect.left + x * stageRect.width;
  const clientY = stageRect.top + y * stageRect.height;
  const distance = Math.hypot(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2));
  const proximity = 1 - clamp(distance / Math.max(180, rect.width * .8), 0, 1);
  stage.style.setProperty("--core-proximity", proximity.toFixed(3));
  holoAnchor.classList.toggle("is-near", proximity > .3);
}

function updateHoloAnchor(result) {
  const rawPalm = result.palm || result.pointer;
  if (!rawPalm) return;
  const palm = result.synthetic ? rawPalm : mapVideoPointToStage(rawPalm);
  const palmScale = clamp(Number(result.palmScale || .1), .04, .24);
  const x = clamp(Number(palm.x), .2, .8);
  const y = clamp(Number(palm.y) - clamp(palmScale * 1.18, .07, .18), .3, .78);
  const scale = clamp(.74 + palmScale * 2.25, .82, 1.26);
  stage.style.setProperty("--holo-x", `${(x * 100).toFixed(2)}%`);
  stage.style.setProperty("--holo-y", `${(y * 100).toFixed(2)}%`);
  stage.style.setProperty("--holo-scale", scale.toFixed(3));
  stage.classList.add("has-tracked-hand");
  handTrackingActive = true;
  window.clearTimeout(handLostTimer);
  drawHandOcclusion(result.landmarks, palmScale);
  setSpatialParallax(x, y);
}

function releaseTrackedHand({ immediate = false } = {}) {
  window.clearTimeout(handLostTimer);
  const release = () => {
    handTrackingActive = false;
    stage.classList.remove("has-tracked-hand");
    stage.style.removeProperty("--holo-x");
    stage.style.removeProperty("--holo-y");
    stage.style.removeProperty("--holo-scale");
    clearHandOcclusion();
  };
  if (immediate) release();
  else handLostTimer = window.setTimeout(release, 420);
}

function toolIsFixture(toolId) {
  return catalogIsFixture || tools.find((tool) => tool.id === toolId)?._fixture === true;
}

resizeHandOcclusion();

const scene = new SceneRenderer(q("[data-scene-canvas]"), {
  onMetrics(value) {
    metrics = value;
    text("[data-hud-fps]", String(value.fps));
    text("[data-hud-frame]", `${value.frameMs.toFixed(1)} ms`);
    text("[data-hud-renderer]", value.renderer);
    root.dataset.renderer = value.renderer;
    root.dataset.sceneState = value.state || "idle";
    root.dataset.fallbackReason = value.fallbackReason || "";
  },
});
store.dispatch({ type: "WORLD_CHANGED", world: "data_constellation" });
scene.setWorld("data_constellation");
scene.start();

const sync = new MultiScreenSync({
  sessionId,
  sourceId,
  role,
  websocketEnabled: config.websocketEnabled,
  csrf: config.csrf,
  apiBase: config.apiBase,
});

sync.setSnapshotProvider(() => {
  const state = store.getState();
  return {
    world: state.world,
    focusedToolId: state.focusedToolId,
    previewToolId: state.previewToolId,
    quality: state.quality,
    visitorMode: state.visitorMode,
  };
});

sync.onMessage((message, transport) => {
  text("[data-hud-sync]", transport);
  if (message.type === "STATE_SNAPSHOT") {
    store.dispatch({ type: "SYNC_SNAPSHOT", snapshot: message.payload, updatedAt: message.sent_at_ms });
    changeWorld(message.payload.world, { broadcast: false });
    if (message.payload.focusedToolId) focusTool(message.payload.focusedToolId, { broadcast: false, instant: true });
    if (message.payload.previewToolId) showPreview(message.payload.previewToolId, { broadcast: false });
    return;
  }
  if (message.type === "SCENE_CHANGED") {
    changeWorld(message.payload.world, { broadcast: false });
  } else if (message.type === "TOOL_FOCUSED") {
    focusTool(message.payload.toolId, { broadcast: false, instant: true });
  } else if (message.type === "TOOL_PREVIEWED") {
    showPreview(message.payload.toolId, { broadcast: false });
  } else if (message.type === "TOOL_RELEASED") {
    closePreview({ broadcast: false, restoreFocus: false });
  }
});

sync.start().then(() => {
  setStatus("[data-sync-status]", role === "controller" ? "主屏同步就绪" : `${role} 屏已加入`, "green");
});

function updateCameraControl(label) {
  const button = q("[data-toggle-camera]");
  const control = q("[data-toggle-camera] span");
  if (button) button.setAttribute("aria-label", label);
  if (control) control.textContent = label;
}

const camera = new CameraController({
  video,
  workerUrl: `${config.assetBase}/js/ai-live-clean/vision-worker.js`,
  modelUrl: config.gestureModel,
  wasmUrl: config.gestureWasm,
  moduleUrl: config.visionModule,
  onResult: handleGesture,
  onStatus(status) {
    text("[data-camera-message]", status.message);
    if (status.state === "requesting") {
      setStatus("[data-camera-status]", "等待摄像头授权", "amber");
      return;
    }
    if (status.state === "active") {
      stage.classList.add("has-camera");
      scene.setCameraActive(true);
      setStatus("[data-camera-status]", "本机镜面已开启", "green");
      updateCameraControl("关闭镜面");
      store.dispatch({ type: "CAMERA_CHANGED", camera: { permission: "granted", active: true, error: null } });
      announce("本机镜面已开启。摄像头画面不会上传或保存。");
      return;
    }
    if (status.state === "gesture_ready") {
      setStatus("[data-gesture-status]", "本地手势已就绪", "green");
      return;
    }
    if (status.state === "model_error" || status.state === "model_fallback") {
      setStatus("[data-gesture-status]", "手势降级 · 键鼠可用", "amber");
      announce(status.message);
      return;
    }
    if (status.state === "denied" || status.state === "unavailable") {
      stage.classList.remove("has-camera");
      scene.setCameraActive(false);
      releaseTrackedHand({ immediate: true });
      setStatus("[data-camera-status]", status.state === "denied" ? "权限已拒绝" : "摄像头不可用", "amber");
      updateCameraControl("开启镜面");
      store.dispatch({ type: "CAMERA_CHANGED", camera: { permission: status.state, active: false, error: status.message } });
      announce(`${status.message} 键盘、鼠标和触摸体验仍可完整使用。`);
    }
  },
});

function leaveEntry() {
  if (root.dataset.state !== "attract") return;
  consentPanel.classList.add("is-leaving");
  setExperienceState("loading");
  scene.activateIonField("entry-left");
  window.setTimeout(() => {
    consentPanel.hidden = true;
    consentPanel.classList.remove("is-leaving");
    stage.tabIndex = 0;
    stage.focus({ preventScroll: true });
  }, reducedMotionQuery.matches ? 0 : 420);
  loadTools();
}

q("[data-enable-camera]").addEventListener("click", async () => {
  leaveEntry();
});

q("[data-skip-camera]").addEventListener("click", leaveEntry);

q("[data-toggle-camera]").addEventListener("click", async () => {
  if (camera.stream) {
    camera.stop();
    stage.classList.remove("has-camera");
    scene.setCameraActive(false);
    releaseTrackedHand({ immediate: true });
    setStatus("[data-camera-status]", "摄像头已关闭", "gray");
    setStatus("[data-gesture-status]", "键鼠可用", "gray");
    updateCameraControl("开启镜面");
    store.dispatch({ type: "CAMERA_CHANGED", camera: { active: false } });
    announce("摄像头已关闭，本地媒体轨道已经释放。");
  } else {
    await camera.start();
  }
});

if (role !== "controller") {
  consentPanel.hidden = true;
  q("[data-toggle-camera]").hidden = true;
  setStatus("[data-camera-status]", "离线演示", "gray");
  setExperienceState("loading");
  scene.activateIonField(`role-${role}`);
  loadTools();
}

async function loadTools() {
  const requestId = ++catalogRequest;
  setExperienceState("loading");
  lensContent.hidden = true;
  lensLoading.hidden = false;
  emptyState.hidden = true;
  q("[data-open-preview]").disabled = true;
  text("[data-experience-status]", "正在连接合成工具目录…");
  try {
    const response = await fetch(`${config.apiBase}/tools`, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`目录服务返回 HTTP ${response.status}`);
    const payload = await response.json();
    if (requestId !== catalogRequest) return;
    const received = Array.isArray(payload.tools) ? payload.tools : [];
    tools = received.filter((tool) => tool && typeof tool.id === "string" && typeof tool.name === "string");
    catalogIsFixture = Boolean(payload.fixture);
    if (!tools.length) {
      showCatalogProblem({
        state: "empty",
        title: "合成工具目录目前为空",
        message: "工具台没有返回可展示的工具。可以重新连接，或者先返回工具台。",
      });
      return;
    }
    activeCategory = "全部";
    renderCategories();
    applyCategory("全部", { focus: false });
    lensLoading.hidden = true;
    lensContent.hidden = false;
    setExperienceState("explore");
    focusTool(visibleTools[0].id, { broadcast: false, instant: true, source: "catalog" });
    text("[data-experience-status]", catalogIsFixture
      ? `已进入演示目录 · ${tools.length} 个 fixture 工具`
      : `已连接 ${tools.length} 个合成工具 · 近场只呈现 7 个能力`);
    announce(`工具目录已就绪，共 ${tools.length} 个工具。`);
    const pending = store.getState();
    if (pending.focusedToolId) focusTool(pending.focusedToolId, { broadcast: false, instant: true });
    if (pending.previewToolId) showPreview(pending.previewToolId, { broadcast: false });
  } catch (error) {
    if (requestId !== catalogRequest) return;
    showCatalogProblem({
      state: "error",
      title: "暂时没有连上工具目录",
      message: `${String(error.message || error).slice(0, 140)}。请检查服务后重试；页面没有改用未标注的假数据。`,
    });
  }
}

function showCatalogProblem({ state, title, message }) {
  tools = [];
  visibleTools = [];
  toolNodes.clear();
  toolSpace.replaceChildren();
  categoryRail.replaceChildren();
  lensLoading.hidden = true;
  lensContent.hidden = true;
  emptyState.hidden = false;
  text("[data-empty-title]", title);
  text("[data-empty-message]", message);
  text("[data-tool-current]", "0");
  text("[data-tool-count]", "0");
  q("[data-previous-tool]").disabled = true;
  q("[data-next-tool]").disabled = true;
  text("[data-experience-status]", state === "error" ? "工具目录连接失败 · 可以重试" : "工具目录为空");
  setExperienceState(state);
  scene.quiet();
  announce(`${title}。${message}`);
}

q("[data-retry-tools]").addEventListener("click", loadTools);

function renderCategories() {
  const counts = new Map();
  tools.forEach((tool) => counts.set(tool.category || "其他", (counts.get(tool.category || "其他") || 0) + 1));
  const categories = [["全部", tools.length], ...[...counts].sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))];
  categoryRail.replaceChildren();
  categories.forEach(([category, count]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wd-ai-category";
    button.dataset.category = category;
    button.setAttribute("aria-pressed", String(category === activeCategory));
    const label = document.createElement("b");
    label.textContent = category;
    const total = document.createElement("span");
    total.textContent = String(count).padStart(2, "0");
    button.append(label, total);
    button.addEventListener("click", () => {
      pauseVisitorTour();
      applyCategory(category);
    });
    categoryRail.append(button);
  });
}

function renderSearchResults(queryValue = searchInput?.value || "") {
  if (!searchResults) return;
  const needle = String(queryValue || "").trim().toLocaleLowerCase("zh-CN");
  const source = activeCategory === "全部" ? tools : visibleTools;
  const matches = source.filter((tool) => {
    if (!needle) return true;
    return [tool.name, tool.category, tool.summary]
      .some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(needle));
  }).slice(0, 24);
  searchResults.replaceChildren();
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "wd-mirror-search-results__empty";
    empty.textContent = needle ? "没有匹配的合成工具" : "当前分类没有可展示的工具";
    searchResults.append(empty);
    return;
  }
  matches.forEach((tool) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wd-mirror-search-result";
    button.dataset.searchToolId = tool.id;
    button.dataset.tone = toolTone(tool);
    button.setAttribute("aria-label", `聚焦 ${tool.name}`);

    const glyph = document.createElement("span");
    glyph.className = "wd-mirror-search-result__glyph";
    renderToolIcon(glyph, tool);
    const copy = document.createElement("span");
    copy.className = "wd-mirror-search-result__copy";
    const name = document.createElement("strong");
    name.textContent = tool.name;
    const summary = document.createElement("span");
    summary.textContent = tool.summary || "暂无能力摘要";
    copy.append(name, summary);
    const category = document.createElement("span");
    category.textContent = tool.category || "其他";
    button.append(glyph, copy, category);
    button.addEventListener("click", () => {
      if (!visibleTools.some((item) => item.id === tool.id)) {
        activeCategory = "全部";
        renderCategories();
        applyCategory("全部", { focus: false });
      }
      focusTool(tool.id, { source: "search" });
      closeSettings();
      stage.focus({ preventScroll: true });
      setCoach("02", "点击查看", `点击「${tool.name}」，它会被方块吸住并展开结果。`);
    });
    searchResults.append(button);
  });
}

searchInput?.addEventListener("input", (event) => renderSearchResults(event.currentTarget.value));

function applyCategory(category, { focus = true } = {}) {
  activeCategory = category;
  visibleTools = category === "全部" ? [...tools] : tools.filter((tool) => (tool.category || "其他") === category);
  categoryRail.querySelectorAll("[data-category]").forEach((button) => {
    const active = button.dataset.category === category;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  renderToolTrack();
  renderSearchResults();
  if (focus && visibleTools[0]) focusTool(visibleTools[0].id, { source: "category" });
  announce(`${category}分类，共 ${visibleTools.length} 个工具。`);
}

function renderToolTrack() {
  toolNodes.clear();
  toolSpace.replaceChildren();
  visibleTools.forEach((tool, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wd-ai-tool";
    button.dataset.toolId = tool.id;
    button.dataset.toolIndex = String(index);
    button.dataset.tone = toolTone(tool);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", "false");
    button.setAttribute("aria-posinset", String(index + 1));
    button.setAttribute("aria-setsize", String(visibleTools.length));
    button.setAttribute("aria-label", `${tool.name}，${tool.summary || "暂无摘要"}`);

    const glyph = document.createElement("span");
    glyph.className = "wd-ai-tool__glyph";
    renderToolIcon(glyph, tool);
    const number = document.createElement("span");
    number.className = "wd-ai-tool__index";
    number.textContent = String(index + 1).padStart(2, "0");
    const name = document.createElement("span");
    name.className = "wd-ai-tool__name";
    name.textContent = tool.name;
    const category = document.createElement("span");
    category.className = "wd-ai-tool__category";
    category.textContent = tool.category || "其他";
    button.append(glyph, number, name, category);

    button.addEventListener("pointerenter", (event) => {
      if (event.pointerType && event.pointerType !== "mouse") return;
      window.clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(() => focusTool(tool.id, { source: "hover" }), 110);
    });
    button.addEventListener("pointerleave", () => window.clearTimeout(hoverTimer));
    button.addEventListener("focus", () => focusTool(tool.id, { instant: root.dataset.inputMode === "keyboard", source: "keyboard" }));
    button.addEventListener("click", (event) => {
      pauseVisitorTour();
      focusTool(tool.id, { source: "click" });
      flashAt(event.clientX || innerWidth / 2, event.clientY || innerHeight / 2);
      showPreview(tool.id);
    });
    toolNodes.set(tool.id, button);
    toolSpace.append(button);
  });
  text("[data-tool-count]", String(visibleTools.length));
  const navigationDisabled = visibleTools.length < 2;
  q("[data-previous-tool]").disabled = navigationDisabled;
  q("[data-next-tool]").disabled = navigationDisabled;
}

function layoutToolRibbon() {
  const count = visibleTools.length;
  if (!count || focusedIndex < 0) return;
  const compact = compactViewportQuery.matches;
  const width = Math.max(toolSpace.clientWidth, compact ? 260 : 520);
  const height = Math.max(toolSpace.clientHeight, compact ? 280 : 440);
  const desktopScale = Math.min(1, width / 540);
  const compactScale = Math.min(1, width / 310);
  const desktopPositions = [
    [-310, 190, 1, 1, 30],
    [-140, 165, .95, .96, 24],
    [-470, 165, .94, .92, 22],
    [30, 115, .9, .9, 16],
    [-610, 110, .88, .86, 14],
    [170, 58, .82, .82, 9],
    [-740, 50, .8, .78, 8],
  ];
  const compactPositions = [
    [0, 58, 1, 1, 18],
    [64, 34, .82, .84, 12],
    [-64, 34, .82, .84, 12],
    [122, -2, .7, .56, 5],
    [-122, -2, .7, .56, 5],
  ];
  toolNodes.forEach((node, id) => {
    const index = visibleTools.findIndex((item) => item.id === id);
    let distance = index - focusedIndex;
    if (distance > count / 2) distance -= count;
    if (distance < -count / 2) distance += count;
    const absolute = Math.abs(distance);
    const visible = absolute <= (compact ? 2 : 3);
    const slot = distance === 0 ? 0 : distance > 0 ? distance * 2 - 1 : Math.abs(distance) * 2;
    const positions = compact ? compactPositions : desktopPositions;
    const [rawX, rawY, rawScale, rawOpacity, rawDepth] = positions[slot] || [0, 0, .52, 0, 0];
    const coordinateScale = compact ? compactScale : desktopScale;
    const heightScale = Math.min(1, height / (compact ? 310 : 460));
    const x = rawX * coordinateScale;
    const y = rawY * heightScale;
    const scale = rawScale;
    const opacity = visible ? rawOpacity : 0;
    node.style.setProperty("--mirror-x", `${x}px`);
    node.style.setProperty("--mirror-y", `${y}px`);
    node.style.setProperty("--mirror-scale", String(scale));
    node.style.setProperty("--mirror-opacity", String(opacity));
    node.style.setProperty("--mirror-turn", `${distance * -2}deg`);
    node.style.setProperty("--mirror-layer", String(8 - Math.min(7, absolute)));
    node.style.setProperty("--mirror-depth", `${rawDepth}px`);
    node.style.setProperty("--mirror-pointer", visible ? "auto" : "none");
    node.dataset.arcDistance = String(distance);
    node.dataset.ringSlot = String(slot);
    node.dataset.spatialVisible = String(visible);
    node.setAttribute("aria-hidden", String(!visible));
    node.tabIndex = visible ? 0 : -1;
  });
}

function renderLens(tool) {
  const index = visibleTools.findIndex((item) => item.id === tool.id);
  text("[data-lens-index]", String(index + 1).padStart(2, "0"));
  text("[data-lens-category]", tool.category || "其他");
  text("[data-lens-title]", tool.name);
  text("[data-lens-summary]", tool.summary || "当前工具还没有提供摘要，打开前仍会经过明确确认。" );
  renderToolIcon(q("[data-lens-glyph]"), tool);
  text("[data-pointer-glyph]", toolGlyph(tool));
  text("[data-tool-current]", String(index + 1));
  q("[data-lens]").dataset.tone = toolTone(tool);
  q("[data-open-preview]").disabled = false;
  q("[data-open-preview]").dataset.toolId = tool.id;
  text("[data-experience-status]", store.getState().visitorMode
    ? `讲解模式 · 正在展示 ${tool.name}`
    : `${tool.name} 已聚焦 · 点击或按 Enter查看能力摘要`);
}

function focusTool(toolId, { broadcast = true, instant = false, source = "programmatic" } = {}) {
  const tool = tools.find((item) => item.id === toolId);
  if (!tool) return false;
  if (!visibleTools.some((item) => item.id === toolId)) {
    activeCategory = "全部";
    renderCategories();
    applyCategory("全部", { focus: false });
  }
  focusedIndex = visibleTools.findIndex((item) => item.id === toolId);
  if (focusedIndex < 0) return false;
  store.dispatch({ type: "FOCUS_CHANGED", toolId });
  toolNodes.forEach((node, id) => {
    const index = visibleTools.findIndex((item) => item.id === id);
    const distance = Math.abs(index - focusedIndex);
    const active = id === toolId;
    node.classList.toggle("is-active", active);
    node.classList.toggle("is-near", !active && distance === 1);
    node.setAttribute("aria-selected", String(active));
  });
  layoutToolRibbon();
  updateSceneAnchors();
  renderLens(tool);
  stage.scrollTop = 0;
  const nucleus = normalizedAnchorForElement(q("[data-lens]"), { fallbackX: .42, fallbackY: .43 });
  scene.setFocus(nucleus.x, nucleus.y, source === "hover" ? .76 : 1.02);
  scene.setInteractionState(source === "catalog" || source === "resize" ? "idle" : "approach");
  if (source !== "catalog" && source !== "resize") {
    setCoach("02", "点击查看", `点击工具「${tool.name}」；结果会从方块后方被拉开。`);
  }
  if (broadcast) sync.send("TOOL_FOCUSED", { toolId });
  return true;
}

function moveFocus(delta) {
  if (!visibleTools.length) return;
  const next = focusedIndex < 0
    ? 0
    : (focusedIndex + delta + visibleTools.length) % visibleTools.length;
  focusTool(visibleTools[next].id, { source: "navigation" });
}

q("[data-previous-tool]").addEventListener("click", () => {
  pauseVisitorTour();
  moveFocus(-1);
});

q("[data-next-tool]").addEventListener("click", () => {
  pauseVisitorTour();
  moveFocus(1);
});

q("[data-open-preview]").addEventListener("click", (event) => {
  const tool = currentTool();
  if (!tool) return;
  pauseVisitorTour();
  flashAt(event.clientX || innerWidth / 2, event.clientY || innerHeight / 2);
  showPreview(tool.id);
});

toolSpace.addEventListener("wheel", (event) => {
  if (!visibleTools.length || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
  event.preventDefault();
  if (wheelTimer) return;
  moveFocus(event.deltaY > 0 ? 1 : -1);
  wheelTimer = window.setTimeout(() => { wheelTimer = 0; }, 210);
}, { passive: false });

async function showPreview(toolId, { broadcast = true } = {}) {
  const tool = tools.find((item) => item.id === toolId);
  if (!tool) return;
  const request = ++previewRequest;
  pointer.classList.remove("is-visible", "is-locked");
  focusTool(toolId, { broadcast: false, source: "preview" });
  store.dispatch({ type: "PREVIEW_CHANGED", toolId });
  if (role === "left" || role === "right") {
    text("[data-experience-status]", `${tool.name} 已在主屏展开预览`);
    if (broadcast) sync.send("TOOL_PREVIEWED", { toolId });
    return;
  }

  setExperienceState("preview-loading");
  stage.classList.add("has-preview");
  previewPanel.hidden = true;
  lensContent.hidden = true;
  lensLoading.hidden = false;
  text("[data-lens-loading] p", `正在读取 ${tool.name} 的能力摘要…`);
  const nucleusAnchor = normalizedAnchorForElement(q("[data-lens]"), { fallbackX: .42, fallbackY: .43 });
  scene.setFocus(nucleusAnchor.x, nucleusAnchor.y, 1.7);
  scene.grab(nucleusAnchor.x, nucleusAnchor.y);
  scene.pulse(nucleusAnchor.x, nucleusAnchor.y, "confirm");
  try {
    const response = await fetch(`${config.apiBase}/tools/${encodeURIComponent(toolId)}/preview`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (request !== previewRequest) return;
    if (!response.ok || !payload.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    const safeTool = payload.preview?.tool || tool;
    previewPanel.dataset.tone = toolTone(safeTool);
    text("[data-preview-category]", safeTool.category || tool.category || "工具");
    text("[data-preview-status]", humanToolStatus(safeTool.status || tool.status));
    text("[data-preview-title]", safeTool.name || tool.name);
    text("[data-preview-summary]", safeTool.summary || tool.summary || "暂无摘要");
    renderToolIcon(q("[data-preview-glyph]"), safeTool);
    text("[data-preview-visual-label]", `${safeTool.category || tool.category || "真实"}能力`);
    text("[data-preview-message]", payload.preview?.message || "确认后才会调用原工具的权限与启动链路。" );
    text("[data-launch-message]", !config.launchEnabled
      ? "示例目录仅供浏览，未连接可启动的工具。"
      : toolIsFixture(toolId)
      ? "演示 fixture 只能预览，不能启动。"
      : store.getState().visitorMode
        ? "讲解模式为只读，不启动合成工具。"
        : "等待明确确认。" );
    const disabled = !config.launchEnabled || toolIsFixture(toolId) || store.getState().visitorMode;
    q("[data-confirm-launch]").disabled = disabled;
    q("[data-confirm-launch]").setAttribute("aria-disabled", String(disabled));
    previewPanel.dataset.error = "false";
  } catch (error) {
    if (request !== previewRequest) return;
    text("[data-preview-category]", tool.category || "工具");
    text("[data-preview-status]", "暂不可用");
    text("[data-preview-title]", tool.name);
    text("[data-preview-summary]", tool.summary || "该工具的只读能力摘要暂时无法读取。" );
    renderToolIcon(q("[data-preview-glyph]"), tool);
    text("[data-preview-visual-label]", "能力摘要暂不可用");
    text("[data-preview-message]", `预览读取失败：${String(error.message || error).slice(0, 140)}。你可以返回继续探索后再次打开。`);
    text("[data-launch-message]", "预览失败时不会启动原工具。" );
    q("[data-confirm-launch]").disabled = true;
    q("[data-confirm-launch]").setAttribute("aria-disabled", "true");
    previewPanel.dataset.error = "true";
  } finally {
    if (request !== previewRequest) return;
    lensLoading.hidden = true;
    lensContent.hidden = false;
    previewPanel.hidden = false;
    setExperienceState("preview");
    setCoach(
      "03",
      "点击查看",
      config.launchEnabled
        ? "先看清真实能力摘要；只有明确确认后，原工具才会打开。"
        : "示例目录仅供浏览，未连接可启动的工具。",
    );
    updateBridgePath();
    updateSceneAnchors();
    const resultAnchor = normalizedAnchorForElement(previewPanel, { fallbackX: .72, fallbackY: .42, anchorX: 0, anchorY: .42 });
    scene.extract(nucleusAnchor.x, nucleusAnchor.y, resultAnchor.x, resultAnchor.y);
    q("[data-close-preview]").focus({ preventScroll: true });
    stage.scrollTop = 0;
  }
  if (broadcast) sync.send("TOOL_PREVIEWED", { toolId });
}

function closePreview({ broadcast = true, restoreFocus = true } = {}) {
  ++previewRequest;
  const toolId = store.getState().previewToolId;
  pointer.classList.remove("is-visible", "is-locked");
  previewPanel.hidden = true;
  stage.classList.remove("has-preview");
  lensContent.hidden = false;
  lensLoading.hidden = true;
  store.dispatch({ type: "PREVIEW_CHANGED", toolId: null });
  setExperienceState(tools.length ? "explore" : "empty");
  scene.release();
  const nucleusAnchor = normalizedAnchorForElement(q("[data-lens]"), { fallbackX: .42, fallbackY: .43 });
  scene.setFocus(nucleusAnchor.x, nucleusAnchor.y, .86);
  updateSceneAnchors();
  if (broadcast && toolId) sync.send("TOOL_RELEASED", { toolId });
  if (restoreFocus && toolId) toolNodes.get(toolId)?.focus({ preventScroll: true });
  stage.scrollTop = 0;
  gestureConfirmSince = 0;
  gestureConfirmFired = false;
  const tool = currentTool();
  if (tool) setCoach("02", "点击查看", `点击工具「${tool.name}」；结果会从方块后方被拉开。`);
  if (store.getState().visitorMode) startVisitorTour();
}

q("[data-close-preview]").addEventListener("click", () => closePreview());
q("[data-return-tool]").addEventListener("click", () => closePreview());

q("[data-confirm-launch]").addEventListener("click", launchCurrentTool);

async function launchCurrentTool() {
  const toolId = store.getState().previewToolId;
  if (!config.launchEnabled) {
    text("[data-launch-message]", "示例目录仅供浏览，未连接可启动的工具。" );
    return;
  }
  if (!toolId || toolIsFixture(toolId) || store.getState().visitorMode) return;
  const request = previewRequest;
  setExperienceState("launching");
  q("[data-confirm-launch]").disabled = true;
  text("[data-launch-message]", "正在通过原工具的权限链路确认…");
  try {
    const response = await fetch(`${config.apiBase}/tools/${encodeURIComponent(toolId)}/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AI-Live-CSRF": config.csrf },
      body: JSON.stringify({ confirmed: true, visitor_mode: false }),
    });
    const payload = await response.json().catch(() => ({}));
    if (request !== previewRequest) return;
    if (!response.ok || !payload.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    const safeUrl = allowedLaunchUrl(payload.open_path);
    text("[data-launch-message]", safeUrl
      ? "工具已启动，已在新窗口打开安全入口。"
      : "工具已启动，但没有返回允许自动打开的同机地址。" );
    flashAt(innerWidth / 2, innerHeight / 2);
    scene.pulse(0.5, 0.5, "confirm");
    if (safeUrl) window.open(safeUrl, "_blank", "noopener,noreferrer");
    announce("原工具已通过权限链路启动。");
  } catch (error) {
    if (request !== previewRequest) return;
    text("[data-launch-message]", `未能打开：${String(error.message || error).slice(0, 160)}。可以再次确认重试，或继续探索。`);
    q("[data-confirm-launch]").disabled = !config.launchEnabled;
    announce("工具没有打开，当前预览和选择已保留。");
  } finally {
    if (request === previewRequest) setExperienceState("preview");
  }
}

function allowedLaunchUrl(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const url = new URL(value, location.origin);
    const localHosts = new Set([location.hostname, "127.0.0.1", "localhost"]);
    if (!localHosts.has(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function flashAt(clientX, clientY) {
  lastInteractionPoint = { x: clientX, y: clientY };
  updateBridgePath(clientX, clientY);
  impact.style.left = `${clientX}px`;
  impact.style.top = `${clientY}px`;
  impact.classList.remove("is-active");
  void impact.offsetWidth;
  impact.classList.add("is-active");
}

function updateBridgePath(clientX, clientY) {
  if (!bridgePath || !bridgeShadow) return;
  const stageRect = stage.getBoundingClientRect();
  const resultRect = previewPanel.hidden ? null : previewPanel.getBoundingClientRect();
  const focusRect = q("[data-lens]")?.getBoundingClientRect();
  const resolvedClientX = focusRect?.width ? focusRect.left + focusRect.width * .94 : Number.isFinite(clientX) ? clientX : stageRect.left + stageRect.width * .42;
  const resolvedClientY = focusRect?.height ? focusRect.top + focusRect.height * .56 : Number.isFinite(clientY) ? clientY : stageRect.top + stageRect.height * .4;
  const startX = Math.max(0, Math.min(100, ((resolvedClientX - stageRect.left) / stageRect.width) * 100));
  const startY = Math.max(0, Math.min(100, ((resolvedClientY - stageRect.top) / stageRect.height) * 100));
  const endX = resultRect ? ((resultRect.left - stageRect.left) / stageRect.width) * 100 : 73;
  const endY = resultRect ? ((resultRect.top + resultRect.height * .42 - stageRect.top) / stageRect.height) * 100 : 48;
  const bendX = startX + (endX - startX) * .38;
  const bendY = Math.max(8, Math.min(92, Math.max(startY, endY) + 12));
  const settleX = endX - (endX - startX) * .16;
  const settleY = Math.max(8, endY - 6);
  const value = `M ${startX.toFixed(2)} ${startY.toFixed(2)} C ${bendX.toFixed(2)} ${bendY.toFixed(2)}, ${settleX.toFixed(2)} ${settleY.toFixed(2)}, ${endX.toFixed(2)} ${endY.toFixed(2)}`;
  bridgePath.setAttribute("d", value);
  bridgeShadow.setAttribute("d", value);
  bridgeMotions.forEach((motion) => motion.setAttribute("path", value));
  bridgeSource?.setAttribute("cx", startX.toFixed(2));
  bridgeSource?.setAttribute("cy", startY.toFixed(2));
  bridgeTarget?.setAttribute("cx", endX.toFixed(2));
  bridgeTarget?.setAttribute("cy", endY.toFixed(2));
  if (bridgePulse) {
    const t = .55;
    const mt = 1 - t;
    const pulseX = mt ** 3 * startX + 3 * mt ** 2 * t * bendX + 3 * mt * t ** 2 * settleX + t ** 3 * endX;
    const pulseY = mt ** 3 * startY + 3 * mt ** 2 * t * bendY + 3 * mt * t ** 2 * settleY + t ** 3 * endY;
    bridgePulse.setAttribute("cx", pulseX.toFixed(2));
    bridgePulse.setAttribute("cy", pulseY.toFixed(2));
  }
}

function normalizedAnchorForElement(element, { fallbackX = .5, fallbackY = .5, anchorX = .5, anchorY = .5 } = {}) {
  if (!element || element.hidden) return { x: fallbackX, y: fallbackY };
  const stageRect = stage.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  if (!stageRect.width || !stageRect.height || !rect.width || !rect.height) return { x: fallbackX, y: fallbackY };
  return {
    x: clamp((rect.left + rect.width * anchorX - stageRect.left) / stageRect.width, 0, 1),
    y: clamp((rect.top + rect.height * anchorY - stageRect.top) / stageRect.height, 0, 1),
  };
}

function updateSceneAnchors() {
  const tool = currentTool();
  const toolNode = tool ? toolNodes.get(tool.id) : null;
  const nucleus = normalizedAnchorForElement(q("[data-lens]"), { fallbackX: .42, fallbackY: .43 });
  const toolAnchor = normalizedAnchorForElement(toolNode, { fallbackX: nucleus.x, fallbackY: nucleus.y });
  const resultAnchor = normalizedAnchorForElement(previewPanel, { fallbackX: .72, fallbackY: .42, anchorX: 0, anchorY: .42 });
  scene.setAnchors([
    { type: "tool", active: Boolean(toolNode), x: toolAnchor.x, y: toolAnchor.y, strength: toolNode ? 1 : .45 },
    { type: "nucleus", active: true, x: nucleus.x, y: nucleus.y, strength: 1 },
    { type: "result", active: !previewPanel.hidden, x: resultAnchor.x, y: resultAnchor.y, strength: previewPanel.hidden ? 0 : 1 },
  ]);
}

function updateVisualPointer(clientX, clientY, { visible = true, locked = false, label = "指向", glyph = null } = {}) {
  lastInteractionPoint = { x: clientX, y: clientY };
  pointer.style.left = `${clientX}px`;
  pointer.style.top = `${clientY}px`;
  pointer.classList.toggle("is-visible", visible);
  pointer.classList.toggle("is-locked", locked);
  const labelNode = pointer.querySelector(".wd-ai-pointer__label");
  if (labelNode) labelNode.textContent = label;
  if (glyph) text("[data-pointer-glyph]", glyph);
}

stage.addEventListener("pointermove", (event) => {
  const rect = stage.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  scene.setPointer(x, y, true, event.pointerType === "touch" ? 1.2 : .72);
  if (!handTrackingActive) setSpatialParallax(x, y);
  const target = event.target.closest?.("[data-tool-id], [data-open-preview], [data-confirm-launch]");
  if (event.pointerType === "mouse" && target) {
    const label = target.matches("[data-confirm-launch]") ? "确认" : target.matches("[data-open-preview]") ? "查看" : "选择";
    const targetTool = tools.find((tool) => tool.id === target.dataset.toolId) || currentTool();
    updateVisualPointer(event.clientX, event.clientY, { visible: true, locked: true, label, glyph: toolGlyph(targetTool) });
  } else if (event.pointerType === "mouse") {
    updateVisualPointer(event.clientX, event.clientY, { visible: false });
  }
});

stage.addEventListener("pointerleave", () => {
  scene.setPointer(.5, .5, false);
  if (!handTrackingActive) setSpatialParallax(.5, .5);
  pointer.classList.remove("is-visible", "is-locked");
});

stage.addEventListener("pointerdown", (event) => {
  root.dataset.inputMode = "pointer";
  pauseVisitorTour();
  const control = event.target.closest?.("button, a, input, select, summary");
  if (control && !control.matches("[data-tool-id], [data-open-preview]")) return;
  const rect = stage.getBoundingClientRect();
  scene.grab((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
}, { capture: true });

stage.addEventListener("pointerup", () => {
  scene.setInteractionState(previewPanel.hidden ? "approach" : "extract");
}, { capture: true });

stage.addEventListener("keydown", (event) => {
  const control = event.target?.closest?.("input, textarea, select, button, a, summary, [contenteditable]:not([contenteditable=\"false\"]), [role=\"textbox\"], [role=\"combobox\"]");
  if (control && !control.matches("[data-tool-id], [data-open-preview]")) return;
  root.dataset.inputMode = "keyboard";
  const previewOpen = !previewPanel.hidden;
  if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key) && !previewOpen) {
    event.preventDefault();
    moveFocus(event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1);
    toolNodes.get(currentTool()?.id)?.focus({ preventScroll: true });
    return;
  }
  if (event.key === "Home" && !previewOpen && visibleTools[0]) {
    event.preventDefault();
    focusTool(visibleTools[0].id, { source: "keyboard" });
    return;
  }
  if (event.key === "End" && !previewOpen && visibleTools.at(-1)) {
    event.preventDefault();
    focusTool(visibleTools.at(-1).id, { source: "keyboard" });
    return;
  }
  if ((event.key === "Enter" || event.key === " ") && !previewOpen && currentTool()) {
    event.preventDefault();
    showPreview(currentTool().id);
    return;
  }
  if (event.key === "Escape") {
    if (!settingsPanel.hidden) closeSettings();
    else if (previewOpen) closePreview();
  }
});

function changeWorld(world, { broadcast = true } = {}) {
  const allowed = new Set(["mirror_nebula", "starship_matrix", "liquid_prism", "data_constellation"]);
  if (!allowed.has(world)) return;
  store.dispatch({ type: "WORLD_CHANGED", world });
  scene.setWorld(world);
  if (broadcast) sync.send("SCENE_CHANGED", { world });
}

function setQuality(quality) {
  const allowed = new Set(["high", "balanced", "low", "reduced"]);
  if (!allowed.has(quality)) return;
  root.dataset.quality = quality;
  store.dispatch({ type: "QUALITY_CHANGED", quality });
  scene.setQuality(quality);
  camera.setInferenceFps(quality === "high" ? 30 : quality === "low" || quality === "reduced" ? 18 : 24);
  q("[data-quality-select]").value = quality;
}

q("[data-quality-select]").addEventListener("change", (event) => setQuality(event.target.value));

function handleReducedMotion(event) {
  if (event.matches) {
    setQuality("reduced");
    stopVisitorTour();
  } else if (store.getState().quality === "reduced") {
    setQuality(compactViewportQuery.matches ? "low" : "balanced");
  }
}

function handleCompactViewport(event) {
  if (reducedMotionQuery.matches) return;
  if (event.matches) setQuality("low");
  else if (store.getState().quality === "low") setQuality("balanced");
}

if (reducedMotionQuery.matches) setQuality("reduced");
else if (compactViewportQuery.matches) setQuality("low");
reducedMotionQuery.addEventListener("change", handleReducedMotion);
compactViewportQuery.addEventListener("change", handleCompactViewport);

function openSettings() {
  settingsPanel.hidden = false;
  q("[data-toggle-hud]").setAttribute("aria-expanded", "true");
  renderSearchResults();
  (searchInput || q("[data-close-hud]")).focus({ preventScroll: true });
}

function closeSettings() {
  settingsPanel.hidden = true;
  q("[data-toggle-hud]").setAttribute("aria-expanded", "false");
  q("[data-toggle-hud]").focus({ preventScroll: true });
}

q("[data-toggle-hud]").addEventListener("click", () => settingsPanel.hidden ? openSettings() : closeSettings());
q("[data-close-hud]").addEventListener("click", closeSettings);

q("[data-toggle-simulator]").addEventListener("click", () => {
  const simulator = q("[data-simulator]");
  simulator.hidden = !simulator.hidden;
  changeWorld(simulator.hidden ? "data_constellation" : "starship_matrix");
  announce(simulator.hidden ? "已关闭同窗三屏示意。" : "同窗三屏示意已打开；真实同步仍使用共享会话。" );
});

q("[data-toggle-visitor]").addEventListener("click", (event) => {
  const enabled = !store.getState().visitorMode;
  store.dispatch({ type: "VISITOR_MODE_CHANGED", enabled });
  root.dataset.visitor = String(enabled);
  event.currentTarget.setAttribute("aria-pressed", String(enabled));
  event.currentTarget.setAttribute("aria-label", enabled ? "退出讲解模式" : "开启讲解模式");
  const label = event.currentTarget.querySelector("span");
  if (label) label.textContent = enabled ? "退出讲解" : "讲解模式";
  q("[data-visitor-note]").hidden = !enabled;
  if (!previewPanel.hidden) closePreview({ broadcast: false });
  const launchButton = q("[data-confirm-launch]");
  launchButton.disabled = !config.launchEnabled || enabled || toolIsFixture(store.getState().previewToolId);
  launchButton.setAttribute("aria-disabled", String(launchButton.disabled));
  if (enabled) {
    activeCategory = "全部";
    renderCategories();
    applyCategory("全部", { focus: true });
    changeWorld("data_constellation");
    startVisitorTour();
  } else {
    stopVisitorTour();
    changeWorld("data_constellation");
  }
  announce(enabled ? "讲解模式已开启：自动轮换、只读展示，不启动合成工具。" : "讲解模式已关闭，已恢复工作体验。" );
});

function startVisitorTour() {
  stopVisitorTour();
  if (!store.getState().visitorMode || reducedMotionQuery.matches || visibleTools.length < 2 || !previewPanel.hidden) return;
  visitorTimer = window.setInterval(() => moveFocus(1), 4800);
}

function stopVisitorTour() {
  if (visitorTimer) window.clearInterval(visitorTimer);
  visitorTimer = 0;
  if (visitorResumeTimer) window.clearTimeout(visitorResumeTimer);
  visitorResumeTimer = 0;
}

function pauseVisitorTour() {
  if (!store.getState().visitorMode) return;
  stopVisitorTour();
  visitorResumeTimer = window.setTimeout(startVisitorTour, 9000);
}

q("[data-open-multiscreen]").addEventListener("click", openMultiScreen);

async function openMultiScreen() {
  const button = q("[data-open-multiscreen]");
  button.disabled = true;
  try {
    if (!("getScreenDetails" in window)) throw new Error("当前 Chrome 未开放 Window Management API");
    const details = await window.getScreenDetails();
    const screens = [...details.screens];
    if (screens.length < 2) throw new Error("当前只检测到一块可用显示器");
    const roles = screens.length >= 3 ? ["left", "center", "right"] : ["center", "right"];
    roles.forEach((screenRole, index) => {
      const screen = screens[index];
      const url = new URL(location.href);
      url.searchParams.set("role", screenRole);
      url.searchParams.set("display", `screen-${index + 1}`);
      url.searchParams.set("session", sessionId);
      window.open(url, `ai-live-${screenRole}-${sessionId}`, `popup,left=${screen.availLeft},top=${screen.availTop},width=${screen.availWidth},height=${screen.availHeight}`);
    });
    setStatus("[data-sync-status]", `已请求 ${roles.length} 个真实窗口`, "green");
    announce(`已请求 ${roles.length} 个真实显示窗口。`);
  } catch (error) {
    q("[data-simulator]").hidden = false;
    changeWorld("starship_matrix");
    setStatus("[data-sync-status]", "多屏权限未满足 · 已显示同窗示意", "amber");
    announce(`${String(error.message || error)}；已显示同窗三屏示意，单屏体验保持可用。`);
  } finally {
    button.disabled = false;
  }
}

function handleGesture(result) {
  latestGestureMs = Number(result.elapsedMs || 0);
  if (!result.pointer || !result.tracking) {
    releaseTrackedHand();
    return;
  }
  updateHoloAnchor(result);
  const now = performance.now();
  const mappedPointer = result.synthetic ? result.pointer : mapVideoPointToStage(result.pointer);
  const x = result.synthetic ? mappedPointer.x : filters.x.next(mappedPointer.x, now);
  const y = result.synthetic ? mappedPointer.y : filters.y.next(mappedPointer.y, now);
  const rect = stage.getBoundingClientRect();
  const point = { x: rect.left + x * rect.width, y: rect.top + y * rect.height };
  const confidence = Number(result.confidence || 0);
  scene.setPointer(x, y, result.tracking, confidence >= .75 ? 1.35 : .76);
  const rawTarget = result.targetId
    ? toolNodes.get(result.targetId)
    : document.elementFromPoint(point.x, point.y)?.closest?.("[data-tool-id]");
  updateVisualPointer(point.x, point.y, {
    visible: Boolean(result.tracking),
    locked: Boolean(rawTarget),
    label: rawTarget ? "点击查看" : previewPanel.hidden ? "指向工具" : "指向确认",
    glyph: toolGlyph(rawTarget ? tools.find((tool) => tool.id === rawTarget.dataset.toolId) : currentTool()),
  });

  if (!previewPanel.hidden) {
    updateGestureLaunch(result, point, now);
    return;
  }

  const update = gestureMachine.update({
    nowMs: now,
    tracking: result.tracking,
    confidence,
    pinchDistance: result.pinchDistance,
    targetId: rawTarget?.dataset.toolId || null,
    point,
  });
  setStatus("[data-gesture-status]", `手势 ${humanGestureState(update.state)}`, confidence >= .65 ? "green" : "amber");
  store.dispatch({ type: "GESTURE_CHANGED", gesture: { state: update.state, confidence, pointer: { x, y } } });
  update.events.forEach((event) => {
    if (event.type === "TARGET_LOCKED") focusTool(event.toolId, { source: "gesture" });
    if (event.type === "GRAB_STARTED") {
      flashAt(point.x, point.y);
      showPreview(event.toolId);
    }
  });
}

function humanGestureState(state) {
  const labels = {
    IDLE: "待命",
    TRACKING: "追踪中",
    AIMING: "指向中",
    TARGET_LOCKED: "已锁定",
    PRE_GRAB: "确认中",
    GRABBED: "已确认",
    DRAGGING: "保持中",
    PREVIEW_OPEN: "预览已开",
    COOLDOWN: "冷却中",
    TRACKING_LOST: "已丢失",
  };
  return labels[state] || state;
}

function updateGestureLaunch(result, point, now) {
  const button = q("[data-confirm-launch]");
  if (!button || button.disabled || !result.tracking || Number(result.confidence || 0) < .65) {
    gestureConfirmSince = 0;
    gestureConfirmFired = false;
    return;
  }
  const rect = button.getBoundingClientRect();
  const inside = point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  const pinched = Number(result.pinchDistance) <= .28;
  if (!inside || !pinched) {
    gestureConfirmSince = 0;
    gestureConfirmFired = false;
    return;
  }
  if (!gestureConfirmSince) gestureConfirmSince = now;
  const elapsed = now - gestureConfirmSince;
  text("[data-launch-message]", `保持确认 ${Math.min(100, Math.round(elapsed / 8))}%`);
  updateVisualPointer(point.x, point.y, { visible: true, locked: true, label: "保持确认" });
  if (elapsed >= 800 && !gestureConfirmFired) {
    gestureConfirmFired = true;
    flashAt(point.x, point.y);
    launchCurrentTool();
  }
}

q("[data-run-gesture-fixture]").addEventListener("click", () => {
  const tool = visibleTools[0];
  const node = tool ? toolNodes.get(tool.id) : null;
  if (!tool || !node) return;
  focusTool(tool.id);
  const rect = node.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  const pointerValue = {
    x: (rect.left + rect.width / 2 - stageRect.left) / stageRect.width,
    y: (rect.top + rect.height / 2 - stageRect.top) / stageRect.height,
  };
  const steps = [
    { delay: 0, pinchDistance: .62 },
    { delay: 140, pinchDistance: .24 },
    { delay: 280, pinchDistance: .22 },
  ];
  steps.forEach((step) => window.setTimeout(() => handleGesture({
    pointer: pointerValue,
    elapsedMs: 4.2,
    synthetic: true,
    targetId: tool.id,
    tracking: true,
    confidence: .94,
    pinchDistance: step.pinchDistance,
  }), step.delay));
  announce("正在重放合成手势 fixture；不含真人录像。" );
});

q("[data-force-model-failure]").addEventListener("click", () => {
  camera.simulateModelFailure();
  setStatus("[data-gesture-status]", "模型失败 fixture · 键鼠可用", "amber");
  announce("已模拟手势模型失败，键盘、鼠标和触摸路径保持可用。" );
});

q("[data-force-webgl-failure]").addEventListener("click", () => {
  announce(scene.forceWebGLFailure());
  root.dataset.quality = "low";
  text("[data-hud-renderer]", "canvas2d-fallback");
});

function updateMemory() {
  text("[data-hud-memory]", `${sync.peers.size} peers · ${latestGestureMs.toFixed(1)} ms`);
  root.dataset.controllerId = sync.controllerId || "";
  root.dataset.syncAuthority = sync.controllerId === sourceId ? "controller" : "follower";
}

const memoryTimer = window.setInterval(updateMemory, 2000);

window.addEventListener("beforeunload", () => {
  window.clearInterval(memoryTimer);
  window.clearTimeout(hoverTimer);
  window.clearTimeout(wheelTimer);
  window.clearTimeout(handLostTimer);
  stopVisitorTour();
  camera.stop();
  sync.close();
  scene.dispose?.();
});

window.addEventListener("resize", () => {
  resizeHandOcclusion();
  const tool = currentTool();
  if (tool) focusTool(tool.id, { broadcast: false, instant: true, source: "resize" });
  layoutToolRibbon();
  if (!previewPanel.hidden) updateBridgePath(lastInteractionPoint.x, lastInteractionPoint.y);
});
