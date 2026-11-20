import * as THREE from "../../vendor/three/build/three.module.min.js";

const QUALITY = {
  high: { count: 960, dpr: 1.5, targetFps: 60, physicsFps: 30 },
  balanced: { count: 640, dpr: 1.25, targetFps: 60, physicsFps: 24 },
  auto: { count: 640, dpr: 1.25, targetFps: 60, physicsFps: 24 },
  low: { count: 240, dpr: 1, targetFps: 30, physicsFps: 15 },
  reduced: { count: 48, dpr: 1, targetFps: 10 },
};

const INTERACTION_STATES = ["idle", "approach", "grab", "extract", "quiet"];
const TRAIL_SEGMENTS = 28;

const WORLD_COLORS = {
  mirror_nebula: [0xffd387, 0x7de7ff, 0xffffff],
  starship_matrix: [0x7de7ff, 0xffd387, 0xf4fbff],
  liquid_prism: [0xffd387, 0xaad8e8, 0xffffff],
  data_constellation: [0xffd387, 0x7de7ff, 0xffffff],
};

const VERTEX_SHADER = `
  attribute float aSize;
  attribute float aPhase;
  attribute float aEnergy;
  varying float vPhase;
  varying float vEnergy;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uPointScale;
  uniform float uWorld;

  void main() {
    vec3 p = position;
    float shimmer = 0.96 + sin(uTime * 0.34 + aPhase * 6.2831) * 0.04;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float perspective = clamp(18.0 / max(4.0, -mv.z), 0.55, 2.6);
    gl_PointSize = aSize * uPixelRatio * uPointScale * shimmer * perspective;
    gl_Position = projectionMatrix * mv;
    vPhase = aPhase;
    vEnergy = aEnergy;
  }
`;

const FRAGMENT_SHADER = `
  varying float vPhase;
  varying float vEnergy;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  uniform float uOpacity;
  uniform float uHalo;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float distanceToCenter = length(uv);
    if (distanceToCenter > 0.5) discard;
    float core = smoothstep(0.19, 0.0, distanceToCenter);
    float aura = smoothstep(0.5, 0.08, distanceToCenter);
    float alpha = mix(core, aura, uHalo) * uOpacity * (0.55 + vEnergy * 0.45);
    vec3 color = mix(uColorA, uColorB, smoothstep(0.05, 0.95, vPhase));
    color = mix(color, uColorC, core * (0.38 + vEnergy * 0.42));
    gl_FragColor = vec4(color, alpha);
  }
`;

function seeded(index, channel = 0) {
  const value = Math.sin(index * 12.9898 + channel * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function formationPoint(world, index, count) {
  const u = seeded(index, 1);
  const v = seeded(index, 2);
  const w = seeded(index, 3);
  const centered = w * 2 - 1;

  if (world === "data_constellation") {
    const progress = index / Math.max(1, count - 1);
    if (progress < 0.3) {
      const rail = progress / 0.3;
      return [
        -4.6 + rail * 8.2 + (u - 0.5) * 0.46,
        -2.25 + Math.sin(rail * Math.PI) * 0.72 + (v - 0.5) * 0.3,
        centered * 2.4 + Math.sin(rail * Math.PI) * 0.55,
      ];
    }
    if (progress < 0.68) {
      const transfer = (progress - 0.3) / 0.38;
      return [
        -1.7 + transfer * 8.4 + Math.sin(transfer * Math.PI) * 0.52 + (u - 0.5) * 0.28,
        0.72 + Math.sin(transfer * Math.PI * 1.15) * 0.92 + (v - 0.5) * 0.42,
        centered * 1.4 + (transfer - 0.5) * 0.65,
      ];
    }
    return [
      5.3 + (u - 0.5) * 3.6,
      (v - 0.5) * 7.2,
      centered * 4.2,
    ];
  }

  const edgeBias = u < 0.5 ? -1 : 1;
  const x = edgeBias * (3.6 + Math.pow(Math.abs(u - 0.5) * 2, 0.72) * 6.2);
  const y = (v - 0.5) * 10.2;
  const z = centered * 7.2;
  if (world === "starship_matrix") {
    return [Math.round(x * 1.4) / 1.4, Math.round(y * 1.1) / 1.1, z];
  }
  if (world === "liquid_prism") {
    return [x + Math.sin(index * 0.91) * 0.42, y + Math.cos(index * 0.67) * 0.34, z];
  }
  return [x, y, z];
}

class CanvasFallback {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: true });
    this.width = 1;
    this.height = 1;
    this.pointer = { x: 0.5, y: 0.5, active: false };
    this.focus = { x: 0.5, y: 0.5, strength: 0 };
    this.interactionState = "idle";
    this.cameraActive = false;
    this.quality = "balanced";
  }

  resize(width, height, dpr) {
    this.width = width;
    this.height = height;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  render(time, world) {
    const ctx = this.context;
    ctx.clearRect(0, 0, this.width, this.height);
    const cx = this.pointer.active ? this.pointer.x * this.width : this.width * 0.5;
    const cy = this.pointer.active ? this.pointer.y * this.height : this.height * 0.48;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(this.width, this.height) * 0.62);
    const accent = world === "starship_matrix" ? "125,231,255" : "255,211,135";
    gradient.addColorStop(0, `rgba(${accent},${this.cameraActive ? ".055" : ".12"})`);
    gradient.addColorStop(0.2, `rgba(${accent},${this.cameraActive ? ".018" : ".035"})`);
    gradient.addColorStop(1, "rgba(3,7,18,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
    if (this.focus.strength > 0.01) {
      ctx.strokeStyle = `rgba(${accent},${this.interactionState === "extract" ? ".34" : ".18"})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const size = this.interactionState === "grab" ? 50 : 68;
      const left = this.focus.x * this.width - size / 2;
      const top = this.focus.y * this.height - size / 2;
      if (typeof ctx.roundRect === "function") ctx.roundRect(left, top, size, size, Math.max(8, size * 0.18));
      else ctx.rect(left, top, size, size);
      ctx.stroke();
    }
    ctx.save();
    ctx.strokeStyle = `rgba(${accent},${this.interactionState === "extract" ? ".42" : ".12"})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 12]);
    ctx.beginPath();
    ctx.moveTo(this.width * 0.42, this.height * 0.43);
    ctx.bezierCurveTo(this.width * 0.52, this.height * 0.5, this.width * 0.6, this.height * 0.26, this.width * 0.68, this.height * 0.36);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = `rgba(${accent},${this.cameraActive ? ".18" : ".32"})`;
    const count = this.cameraActive ? 18 : 36;
    for (let index = 0; index < count; index += 1) {
      const drift = this.quality === "reduced" ? 0 : Math.sin(time * .16 + index) * 4;
      let x;
      let y;
      if (index < count * 0.34) {
        const rail = index / Math.max(1, count * 0.34 - 1);
        x = this.width * (0.1 + rail * 0.48);
        y = this.height * (0.68 - Math.sin(rail * Math.PI) * 0.07) + drift;
      } else if (index < count * 0.7) {
        const transfer = (index - count * 0.34) / Math.max(1, count * 0.36);
        x = this.width * (0.42 + transfer * 0.28);
        y = this.height * (0.43 - Math.sin(transfer * Math.PI) * 0.12) + drift;
      } else {
        x = this.width * (0.69 + seeded(index, 10) * 0.24);
        y = this.height * (0.16 + seeded(index, 9) * 0.62) + drift;
      }
      ctx.beginPath();
      ctx.arc(x, y, 0.4 + seeded(index, 11) * 0.85, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export class SceneRenderer {
  constructor(canvas, { onMetrics } = {}) {
    this.canvas = canvas;
    this.onMetrics = onMetrics || (() => {});
    this.world = "data_constellation";
    this.quality = "balanced";
    this.running = false;
    this.frameHandle = 0;
    this.lastFrame = 0;
    this.lastPhysics = 0;
    this.samples = [];
    this.pointer = { x: 0, y: 0, active: false, strength: 0 };
    this.focus = { x: 0, y: 0, strength: 0 };
    this.toolAnchor = { x: 0, y: 0, strength: 0 };
    this.resultAnchor = { x: 0, y: 0, strength: 0 };
    this.interactionState = "idle";
    this.stateTargets = { idle: 1, approach: 0, grab: 0, extract: 0, quiet: 0 };
    this.stateStrengths = { idle: 1, approach: 0, grab: 0, extract: 0, quiet: 0 };
    this.fallbackReason = "deferred_until_entry";
    this.fallbackRenderer = "canvas2d-depth-stage";
    this.destroyed = false;
    this.contextLost = false;
    this.contextRecoveryTimer = 0;
    this.contextLossHandler = (event) => {
      event.preventDefault();
      if (this.destroyed) return;
      this.contextLost = true;
      this.enableFallback({ reason: "webgl_context_lost" });
      this.resize();
      this.start();
      window.clearTimeout(this.contextRecoveryTimer);
      this.contextRecoveryTimer = window.setTimeout(() => this.activateIonField("webgl_context_lost_retry"), 900);
    };
    this.contextRestoreHandler = () => {
      if (this.destroyed) return;
      this.contextLost = false;
      window.setTimeout(() => this.activateIonField("webgl_context_restored"), 120);
    };
    this.anchors = [];
    this.pulses = [];
    this.cameraActive = false;
    this.fallback = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.geometry = null;
    this.materials = [];
    this.auxMaterials = [];
    this.webglAvailable = true;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.visibilityHandler = () => document.hidden ? this.pause() : this.start();
    document.addEventListener("visibilitychange", this.visibilityHandler);

    // The interface already carries its visual depth through CSS surfaces and
    // spatial tool choreography.  Keep the ambient canvas deliberately light:
    // some managed-company Chrome/GPU combinations can stall while creating a
    // WebGL context, which would delay the first real interaction.
    this.enableFallback({ replaceCanvas: false });
    this.resize();
    this.reseed();
    this.onMetrics({ fps: 0, frameMs: 0, renderer: "canvas2d-depth-stage", particles: 36 });
  }

  initWebGL() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: false,
      powerPreference: "high-performance",
      failIfMajorPerformanceCaveat: true,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 80);
    this.camera.position.set(0, 0, 15);
    this.createIonCore();
    this.createChoreography();
  }

  createIonCore() {
    const group = new THREE.Group();
    const cubeGeometry = new THREE.BoxGeometry(1.34, 1.34, 0.28);
    const edgeGeometry = new THREE.EdgesGeometry(cubeGeometry);
    cubeGeometry.dispose();
    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xffd387, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false });
    const haloGeometry = new THREE.PlaneGeometry(2.9, 2.9);
    const haloMaterial = new THREE.MeshBasicMaterial({ color: 0xffd387, transparent: true, opacity: 0.018, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    group.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));
    group.add(new THREE.Mesh(haloGeometry, haloMaterial));
    group.userData.tick = (time, focusStrength) => {
      edgeMaterial.opacity = 0.1 + focusStrength * 0.18;
      haloMaterial.opacity = 0.012 + focusStrength * 0.026;
      group.rotation.y = Math.sin(time * 0.32) * 0.08;
      group.scale.setScalar(0.94 + focusStrength * 0.07);
    };
    this.auxMaterials.push(edgeMaterial, haloMaterial);
    this.ionCore = group;
    this.scene.add(group);
  }

  createChoreography() {
    this.choreography = new THREE.Group();
    const focusBeamMaterial = new THREE.LineBasicMaterial({ color: 0xffd387, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.focusBeam = new THREE.Line(new THREE.BufferGeometry(), focusBeamMaterial);
    this.focusBeam.frustumCulled = false;
    this.auxMaterials.push(focusBeamMaterial);
    this.choreography.add(this.focusBeam);

    this.focusReticle = new THREE.Group();
    [0.38, 0.62, 0.9].forEach((radius, index) => {
      const points = [];
      for (let step = 0; step < 40; step += 1) {
        const angleA = (step / 44) * Math.PI * 2 + index * 0.34;
        const angleB = ((step + 0.6) / 44) * Math.PI * 2 + index * 0.34;
        points.push(new THREE.Vector3(Math.cos(angleA) * radius, Math.sin(angleA) * radius, index * -0.08));
        points.push(new THREE.Vector3(Math.cos(angleB) * radius, Math.sin(angleB) * radius, index * -0.08));
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({ color: index === 1 ? 0x7de7ff : 0xffd387, transparent: true, opacity: 0.3 - index * 0.065, blending: THREE.AdditiveBlending, depthWrite: false });
      this.auxMaterials.push(material);
      this.focusReticle.add(new THREE.LineSegments(geometry, material));
    });
    this.focusReticle.visible = false;
    this.choreography.add(this.focusReticle);

    this.trailPositions = new Float32Array(TRAIL_SEGMENTS * 2 * 3);
    this.trailGeometry = new THREE.BufferGeometry();
    this.trailGeometry.setAttribute("position", new THREE.BufferAttribute(this.trailPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.trailMaterial = new THREE.LineBasicMaterial({ color: 0xffd387, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.trail = new THREE.LineSegments(this.trailGeometry, this.trailMaterial);
    this.trail.frustumCulled = false;
    this.auxMaterials.push(this.trailMaterial);
    this.choreography.add(this.trail);
    this.scene.add(this.choreography);
  }

  setAnchors(anchors) {
    this.anchors = Array.isArray(anchors) ? anchors.slice(0, 16) : [];
    const tool = this.anchors.find((anchor) => anchor?.type === "tool" && anchor.active) || this.anchors.find((anchor) => anchor?.type === "tool");
    const result = this.anchors.find((anchor) => anchor?.type === "result");
    if (tool) this.setToolAnchor(tool.x, tool.y, tool.strength ?? 1);
    if (result) this.setResultAnchor(result.x, result.y, result.strength ?? 1);
  }

  replaceCanvasForFreshContext() {
    const replacement = this.canvas.cloneNode(false);
    this.canvas.removeEventListener("webglcontextlost", this.contextLossHandler);
    this.canvas.removeEventListener("webglcontextrestored", this.contextRestoreHandler);
    this.canvas.replaceWith(replacement);
    this.canvas = replacement;
    return replacement;
  }

  disposeWebGL({ loseContext = false } = {}) {
    const geometries = new Set(this.geometry ? [this.geometry] : []);
    const materials = new Set([...this.materials, ...this.auxMaterials]);
    this.scene?.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      const owned = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      owned.forEach((material) => materials.add(material));
    });
    geometries.forEach((geometry) => geometry.dispose?.());
    materials.forEach((material) => material.dispose?.());
    if (loseContext) this.renderer?.forceContextLoss?.();
    this.renderer?.dispose?.();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.geometry = null;
    this.materials = [];
    this.auxMaterials = [];
    this.points = [];
    this.ionCore = null;
    this.choreography = null;
    this.focusBeam = null;
    this.focusReticle = null;
    this.trail = null;
    this.trailGeometry = null;
    this.trailMaterial = null;
  }

  activateIonField(reason = "entered_experience") {
    if (this.destroyed) return false;
    if (this.renderer) {
      this.fallbackReason = "";
      this.onMetrics({ fps: 0, frameMs: 0, renderer: "webgl-ion-field", particles: this.count || QUALITY[this.quality].count, state: this.interactionState, fallbackReason: "" });
      return true;
    }
    try {
      this.replaceCanvasForFreshContext();
      this.fallback = null;
      this.webglAvailable = true;
      this.contextLost = false;
      this.initWebGL();
      this.canvas.addEventListener("webglcontextlost", this.contextLossHandler, false);
      this.canvas.addEventListener("webglcontextrestored", this.contextRestoreHandler, false);
      this.resize();
      this.reseed();
      this.fallbackReason = "";
      this.setInteractionState(this.interactionState === "quiet" ? "quiet" : "idle");
      this.start();
      this.onMetrics({ fps: 0, frameMs: 0, renderer: "webgl-ion-field", particles: this.count, state: this.interactionState, fallbackReason: "", activatedBy: reason });
      return true;
    } catch (error) {
      this.enableFallback({ reason: `webgl_init_failed:${String(error?.message || error).slice(0, 80)}` });
      this.resize();
      this.start();
      return false;
    }
  }

  enableFallback({ replaceCanvas = true, reason = "webgl_unavailable" } = {}) {
    this.webglAvailable = false;
    this.fallbackReason = reason;
    this.disposeWebGL({ loseContext: !this.contextLost });
    if (replaceCanvas) {
      this.replaceCanvasForFreshContext();
    }
    this.fallback = new CanvasFallback(this.canvas);
    this.fallbackRenderer = replaceCanvas ? "canvas2d-fallback" : "canvas2d-depth-stage";
    this.fallback.cameraActive = this.cameraActive;
    this.fallback.quality = this.quality;
    this.fallback.focus = { x: 0.5, y: 0.5, strength: this.focus.strength };
    this.fallback.interactionState = this.interactionState;
    this.onMetrics({ fps: 0, frameMs: 0, renderer: this.fallbackRenderer, particles: this.quality === "reduced" ? 48 : 36, state: this.interactionState, fallbackReason: reason });
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const settings = QUALITY[this.quality] || QUALITY.balanced;
    const dpr = Math.min(window.devicePixelRatio || 1, settings.dpr);
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    if (this.renderer) {
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(this.width, this.height, false);
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
      this.materials.forEach((material) => material.uniforms.uPixelRatio.value = dpr);
    } else if (this.fallback) {
      this.fallback.resize(this.width, this.height, dpr);
    }
  }

  setWorld(world) {
    if (!WORLD_COLORS[world]) return;
    this.world = world;
    this.retargetHomes();
    this.updateColors();
    this.pulse(0.5, 0.5, "world");
  }

  setQuality(quality) {
    if (!QUALITY[quality]) return;
    const changedCount = QUALITY[this.quality]?.count !== QUALITY[quality].count;
    this.quality = quality;
    if (this.fallback) this.fallback.quality = quality;
    this.resize();
    if (changedCount) this.reseed();
  }

  setCameraActive(active) {
    this.cameraActive = Boolean(active);
    if (this.fallback) this.fallback.cameraActive = this.cameraActive;
    this.updateParticleVisibility();
  }

  updateParticleVisibility() {
    const quiet = this.stateStrengths.quiet || 0;
    const opacities = this.cameraActive
      ? [0.01 * (1 - quiet), 0.16 * (1 - quiet)]
      : [0.024 * (1 - quiet * 0.65), 0.42 * (1 - quiet * 0.55)];
    this.materials.forEach((material, index) => {
      material.uniforms.uOpacity.value = opacities[index] ?? 0;
    });
  }

  normalizedToWorld(x, y, z = 0) {
    const clampedX = Math.max(0, Math.min(1, x));
    const clampedY = Math.max(0, Math.min(1, y));
    if (!this.camera) {
      return {
        x: (clampedX - 0.5) * 2,
        y: (0.5 - clampedY) * 2,
      };
    }
    const distance = Math.max(1, this.camera.position.z - z);
    const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5)) * distance;
    return {
      x: (clampedX - 0.5) * visibleHeight * this.camera.aspect,
      y: (0.5 - clampedY) * visibleHeight,
    };
  }

  setPointer(x, y, active = true, strength = 1) {
    const point = this.normalizedToWorld(x, y);
    this.pointer.x = point.x;
    this.pointer.y = point.y;
    this.pointer.active = active;
    this.pointer.strength = active ? Math.max(0.15, Math.min(1.8, strength)) : 0;
    if (this.fallback) this.fallback.pointer = { x, y, active };
    if (active && this.interactionState !== "grab" && this.interactionState !== "extract") this.setInteractionState("approach");
    if (!active && this.interactionState === "approach") this.setInteractionState("idle");
  }

  setFocus(x, y, strength = 1) {
    const point = this.normalizedToWorld(x, y);
    this.focus.x = point.x;
    this.focus.y = point.y;
    this.focus.strength = Math.max(0, Math.min(2, strength));
    if (this.fallback) this.fallback.focus = { x, y, strength: this.focus.strength };
    if (this.focusReticle) {
      this.focusReticle.visible = this.focus.strength > 0.01;
      this.focusReticle.position.set(this.focus.x, this.focus.y, 0.8);
    }
    if (this.focusBeam) {
      const side = this.focus.x < 0 ? -1 : 1;
      const bend = new THREE.Vector3(this.focus.x * 0.52 + side * 0.55, this.focus.y * 0.58, 0.06);
      this.focusBeam.geometry.dispose();
      this.focusBeam.geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(this.focus.x, this.focus.y, 0.12),
        bend,
        new THREE.Vector3(0, 0, -0.35),
      ]);
      this.focusBeam.material.opacity = 0.12 + this.focus.strength * 0.1;
    }
  }

  clearFocus() {
    this.focus.strength = 0;
    if (this.focusReticle) this.focusReticle.visible = false;
    if (this.focusBeam) this.focusBeam.material.opacity = 0;
  }

  setToolAnchor(x, y, strength = 1) {
    const point = this.normalizedToWorld(x, y, 0.35);
    this.toolAnchor = { x: point.x, y: point.y, strength: Math.max(0, Math.min(2, strength)) };
  }

  setResultAnchor(x, y, strength = 1) {
    const point = this.normalizedToWorld(x, y, 0.1);
    this.resultAnchor = { x: point.x, y: point.y, strength: Math.max(0, Math.min(2, strength)) };
  }

  setInteractionState(state) {
    if (!INTERACTION_STATES.includes(state)) return;
    this.interactionState = state;
    INTERACTION_STATES.forEach((name) => {
      this.stateTargets[name] = name === state ? 1 : 0;
    });
    if (state === "quiet") this.stateTargets.idle = 0.25;
    if (state === "approach") this.stateTargets.idle = 0.45;
    if (this.fallback) this.fallback.interactionState = state;
  }

  grab(x = 0.5, y = 0.5) {
    this.setPointer(x, y, true, 1.45);
    this.setInteractionState("grab");
    this.pulse(x, y, "grab");
  }

  extract(fromX = 0.5, fromY = 0.5, toX = 0.74, toY = 0.46) {
    this.setFocus(fromX, fromY, 1.75);
    this.setResultAnchor(toX, toY, 1);
    this.setInteractionState("extract");
    this.pulse(fromX, fromY, "confirm");
  }

  quiet() {
    this.setInteractionState("quiet");
  }

  release() {
    this.setInteractionState("idle");
    this.pulse(0.5, 0.5, "release");
  }

  pulse(x, y, kind = "confirm") {
    const point = this.normalizedToWorld(x, y);
    this.pulses.push({
      x: point.x,
      y: point.y,
      radius: kind === "release" ? 3.8 : kind === "grab" ? 2.2 : 0.2,
      velocity: kind === "world" ? 0.11 : kind === "release" ? -0.085 : kind === "grab" ? -0.13 : 0.16,
      strength: kind === "release" ? -0.82 : kind === "world" ? 0.5 : kind === "grab" ? -1.05 : 1.25,
      life: 1,
    });
    if (this.pulses.length > 5) this.pulses.shift();
  }

  reseed() {
    if (!this.renderer) return;
    const count = QUALITY[this.quality]?.count || QUALITY.balanced.count;
    this.geometry?.dispose();
    this.materials.forEach((material) => material.dispose());
    this.points?.forEach((points) => this.scene.remove(points));
    this.materials = [];
    this.points = [];
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.homes = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.phases = new Float32Array(count);
    this.energies = new Float32Array(count);
    this.sizes = new Float32Array(count);

    for (let index = 0; index < count; index += 1) {
      const [x, y, z] = formationPoint(this.world, index, count);
      const offset = index * 3;
      this.homes[offset] = x;
      this.homes[offset + 1] = y;
      this.homes[offset + 2] = z;
      this.positions[offset] = x + (seeded(index, 6) - 0.5) * 0.5;
      this.positions[offset + 1] = y + (seeded(index, 7) - 0.5) * 0.5;
      this.positions[offset + 2] = z + (seeded(index, 8) - 0.5) * 0.5;
      this.phases[index] = seeded(index, 4);
      this.energies[index] = Math.pow(seeded(index, 5), 0.72);
      this.sizes[index] = 0.76 + Math.pow(seeded(index, 9), 2.2) * 2.15;
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("aPhase", new THREE.BufferAttribute(this.phases, 1));
    this.geometry.setAttribute("aEnergy", new THREE.BufferAttribute(this.energies, 1));
    this.geometry.setAttribute("aSize", new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20);

    const makeMaterial = (halo) => new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, QUALITY[this.quality].dpr) },
        uPointScale: { value: halo ? 2.15 : 0.92 },
        uWorld: { value: 0 },
        uOpacity: { value: halo ? 0.024 : 0.42 },
        uHalo: { value: halo ? 1 : 0.24 },
        uColorA: { value: new THREE.Color() },
        uColorB: { value: new THREE.Color() },
        uColorC: { value: new THREE.Color() },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });

    const haloMaterial = makeMaterial(true);
    const coreMaterial = makeMaterial(false);
    this.materials.push(haloMaterial, coreMaterial);
    this.points.push(new THREE.Points(this.geometry, haloMaterial), new THREE.Points(this.geometry, coreMaterial));
    this.points.forEach((points) => {
      points.frustumCulled = false;
      this.scene.add(points);
    });
    this.updateParticleVisibility();
    this.updateColors();
    this.resize();
    this.onMetrics({ fps: 0, frameMs: 0, renderer: "webgl-ion-field", particles: count });
  }

  retargetHomes() {
    if (!this.homes) return;
    for (let index = 0; index < this.count; index += 1) {
      const point = formationPoint(this.world, index, this.count);
      const offset = index * 3;
      this.homes[offset] = point[0];
      this.homes[offset + 1] = point[1];
      this.homes[offset + 2] = point[2];
    }
  }

  updateColors() {
    if (!this.materials.length) return;
    const colors = WORLD_COLORS[this.world];
    const worldIndex = Object.keys(WORLD_COLORS).indexOf(this.world);
    this.materials.forEach((material) => {
      material.uniforms.uColorA.value.setHex(colors[0]);
      material.uniforms.uColorB.value.setHex(colors[1]);
      material.uniforms.uColorC.value.setHex(colors[2]);
      material.uniforms.uWorld.value = Math.max(0, worldIndex);
    });
    this.auxMaterials.forEach((material, index) => material.color?.setHex(colors[index % 2]));
    this.focusBeam?.material?.color?.setHex(colors[0]);
    this.trailMaterial?.color?.setHex(colors[0]);
  }

  start() {
    if (this.running || document.hidden) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.frameHandle = requestAnimationFrame((time) => this.frame(time));
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  frame(time) {
    if (!this.running) return;
    const settings = QUALITY[this.quality] || QUALITY.balanced;
    const elapsed = time - this.lastFrame;
    const target = 1000 / settings.targetFps;
    if (elapsed >= target * 0.82) {
      const delta = Math.min(2, elapsed / 16.667);
      this.draw(time / 1000, delta);
      this.lastFrame = time;
      this.samples.push(elapsed);
      if (this.samples.length > 150) this.samples.shift();
      if (this.samples.length % 30 === 0) {
        const average = this.samples.reduce((sum, value) => sum + value, 0) / this.samples.length;
        this.onMetrics({
          fps: Math.round(1000 / average),
          frameMs: average,
          renderer: this.renderer ? "webgl-ion-field" : this.fallbackRenderer,
          particles: this.renderer ? this.count : 36,
          state: this.interactionState,
          fallbackReason: this.renderer ? "" : this.fallbackReason,
        });
        if (this.quality === "auto" && this.samples.length >= 90 && average > 22) this.setQuality("low");
      }
    }
    this.frameHandle = requestAnimationFrame((next) => this.frame(next));
  }

  draw(time, delta) {
    if (!this.renderer) {
      this.fallback?.render(time, this.world);
      return;
    }
    const reduced = this.quality === "reduced";
    const sceneTime = reduced ? 0 : time;
    const ease = reduced ? 1 : 0.12 * Math.max(0.5, Math.min(2, delta));
    INTERACTION_STATES.forEach((state) => {
      this.stateStrengths[state] += (this.stateTargets[state] - this.stateStrengths[state]) * ease;
    });
    this.updateParticleVisibility();
    const physicsFps = QUALITY[this.quality]?.physicsFps || 0;
    if (!reduced && (!this.lastPhysics || time - this.lastPhysics >= 1 / physicsFps)) {
      const physicsDelta = this.lastPhysics ? Math.min(2, (time - this.lastPhysics) * 60) : delta;
      this.simulate(time, physicsDelta);
      this.lastPhysics = time;
    }
    this.materials.forEach((material) => material.uniforms.uTime.value = sceneTime);
    this.ionCore?.userData.tick?.(sceneTime, this.focus.strength);
    if (this.choreography) {
      this.choreography.rotation.z = reduced ? 0 : Math.sin(sceneTime * 0.075) * 0.025;
    }
    if (this.focusReticle?.visible) {
      this.focusReticle.rotation.z = reduced ? 0 : sceneTime * 0.36;
      const focusScale = 0.82 + this.focus.strength * 0.24 + this.stateStrengths.grab * 0.18 + (reduced ? 0 : Math.sin(sceneTime * 3.1) * 0.025);
      this.focusReticle.scale.setScalar(focusScale);
    }
    this.updateExtractionTrail(sceneTime);
    const parallax = !reduced && this.pointer.active ? 1 : 0;
    this.camera.position.x += ((this.pointer.x * 0.018 * parallax) - this.camera.position.x) * (reduced ? 1 : 0.035);
    this.camera.position.y += ((this.pointer.y * 0.018 * parallax) - this.camera.position.y) * (reduced ? 1 : 0.035);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }

  updateExtractionTrail(time) {
    if (!this.trailGeometry || !this.trailMaterial || !this.trailPositions) return;
    const extract = this.stateStrengths.extract || 0;
    const grab = this.stateStrengths.grab || 0;
    const active = Math.max(extract, grab * 0.35);
    this.trailMaterial.opacity = active * (this.cameraActive ? 0.28 : 0.48);
    const startX = this.toolAnchor.strength > 0.01 ? this.toolAnchor.x : this.focus.x;
    const startY = this.toolAnchor.strength > 0.01 ? this.toolAnchor.y : this.focus.y;
    const endX = this.resultAnchor.strength > 0.01 ? this.resultAnchor.x : 0;
    const endY = this.resultAnchor.strength > 0.01 ? this.resultAnchor.y : 0;
    for (let segment = 0; segment < TRAIL_SEGMENTS; segment += 1) {
      const t0 = segment / TRAIL_SEGMENTS;
      const t1 = (segment + 0.54) / TRAIL_SEGMENTS;
      for (let slot = 0; slot < 2; slot += 1) {
        const t = slot === 0 ? t0 : t1;
        const wave = Math.sin(t * Math.PI) * (0.34 + active * 0.32);
        const drift = Math.sin(time * 1.8 + segment * 0.7) * 0.025;
        const x = startX + (endX - startX) * t + wave * 0.24 + drift;
        const y = startY + (endY - startY) * t + Math.sin(t * Math.PI * 1.22) * 0.34;
        const offset = (segment * 2 + slot) * 3;
        this.trailPositions[offset] = x;
        this.trailPositions[offset + 1] = y;
        this.trailPositions[offset + 2] = -0.2 + t * 0.4;
      }
    }
    this.trailGeometry.attributes.position.needsUpdate = true;
  }

  simulate(time, delta) {
    const spring = this.world === "liquid_prism" ? 0.006 : 0.009;
    const damping = Math.pow(0.92, delta);
    const pointerRadius = 2.45 + this.pointer.strength * 0.72;
    const pointerRadiusSq = pointerRadius * pointerRadius;
    const focusStrength = this.focus.strength;
    const approach = this.stateStrengths.approach || 0;
    const grab = this.stateStrengths.grab || 0;
    const extract = this.stateStrengths.extract || 0;
    const quiet = this.stateStrengths.quiet || 0;
    const toolStrength = this.toolAnchor.strength || 0;
    const resultStrength = this.resultAnchor.strength || 0;
    const pulseCount = this.pulses.length;

    for (let index = 0; index < this.count; index += 1) {
      const offset = index * 3;
      let x = this.positions[offset];
      let y = this.positions[offset + 1];
      let z = this.positions[offset + 2];
      let vx = this.velocities[offset];
      let vy = this.velocities[offset + 1];
      let vz = this.velocities[offset + 2];

      vx += (this.homes[offset] - x) * spring * delta;
      vy += (this.homes[offset + 1] - y) * spring * delta;
      vz += (this.homes[offset + 2] - z) * spring * delta;

      const driftScale = 1 - quiet * 0.78;
      const drift = Math.sin(time * 0.12 + this.phases[index] * 19) * 0.00008 * delta * driftScale;
      vx += drift;
      vy += Math.cos(time * 0.1 + this.phases[index] * 23) * 0.00006 * delta * driftScale;

      if (this.pointer.active) {
        const dx = x - this.pointer.x;
        const dy = y - this.pointer.y;
        const distanceSq = dx * dx + dy * dy + 0.08;
        if (distanceSq < pointerRadiusSq) {
          const force = (1 - distanceSq / pointerRadiusSq) * (0.06 + approach * 0.06) * this.pointer.strength * delta;
          const inverse = 1 / Math.sqrt(distanceSq);
          const tangent = (this.phases[index] < 0.5 ? -1 : 1) * approach;
          vx += (dx * inverse + -dy * inverse * tangent * 0.45) * force;
          vy += (dy * inverse + dx * inverse * tangent * 0.45) * force;
          vz += (this.phases[index] - 0.5) * force * 0.65;
        }
      }

      if (focusStrength > 0.01) {
        const dx = this.focus.x - x;
        const dy = this.focus.y - y;
        const distanceSq = dx * dx + dy * dy + 0.3;
        const force = Math.min(0.022, 0.055 / distanceSq) * focusStrength * delta;
        vx += dx * force;
        vy += dy * force;
        vz += (-z + Math.sin(this.phases[index] * 12) * 0.45) * force * 0.4;
      }

      if (toolStrength > 0.01) {
        const dx = this.toolAnchor.x - x;
        const dy = this.toolAnchor.y - y;
        const selected = index % 5 === 0 || this.energies[index] > 0.78;
        const pull = (selected ? 0.018 : 0.006) * toolStrength * (0.45 + focusStrength * 0.5 + grab * 1.8) * delta;
        vx += dx * pull;
        vy += dy * pull;
        vz += (-0.35 - z) * pull * 0.55;
      }

      if (grab > 0.01) {
        const dx = this.focus.x - x;
        const dy = this.focus.y - y;
        const distanceSq = dx * dx + dy * dy + 0.45;
        const force = Math.min(0.08, 0.14 / distanceSq) * grab * delta;
        vx += dx * force;
        vy += dy * force;
        vz += (-0.15 - z) * force * 0.7;
      }

      if (extract > 0.01 && resultStrength > 0.01 && index % 4 === 0) {
        const phase = (this.phases[index] + time * 0.08) % 1;
        const curve = Math.sin(phase * Math.PI);
        const targetX = this.toolAnchor.x + (this.resultAnchor.x - this.toolAnchor.x) * phase + curve * 0.36;
        const targetY = this.toolAnchor.y + (this.resultAnchor.y - this.toolAnchor.y) * phase + Math.sin(phase * Math.PI * 1.4) * 0.48;
        const force = (0.012 + this.energies[index] * 0.018) * extract * delta;
        vx += (targetX - x) * force;
        vy += (targetY - y) * force;
        vz += ((phase - 0.5) * 0.8 - z) * force * 0.55;
      }

      for (let pulseIndex = 0; pulseIndex < pulseCount; pulseIndex += 1) {
        const pulse = this.pulses[pulseIndex];
        const dx = x - pulse.x;
        const dy = y - pulse.y;
        const distance = Math.sqrt(dx * dx + dy * dy) + 0.001;
        const band = Math.max(0, 1 - Math.abs(distance - pulse.radius) / 0.85);
        if (band > 0) {
          const force = band * pulse.strength * 0.052 * delta;
          vx += (dx / distance) * force;
          vy += (dy / distance) * force;
          vz += (this.phases[index] - 0.5) * force * 0.45;
        }
      }

      const quietDamping = Math.pow(0.86, quiet * delta);
      vx *= damping * quietDamping;
      vy *= damping * quietDamping;
      vz *= damping * quietDamping;
      this.velocities[offset] = vx;
      this.velocities[offset + 1] = vy;
      this.velocities[offset + 2] = vz;
      this.positions[offset] = x + vx * delta;
      this.positions[offset + 1] = y + vy * delta;
      this.positions[offset + 2] = z + vz * delta;
    }

    this.pulses.forEach((pulse) => {
      pulse.radius += pulse.velocity * delta;
      pulse.life -= 0.014 * delta;
      pulse.strength *= Math.pow(0.985, delta);
    });
    this.pulses = this.pulses.filter((pulse) => pulse.life > 0 && pulse.radius > 0.05 && pulse.radius < 18);
    this.geometry.attributes.position.needsUpdate = true;
  }

  forceWebGLFailure() {
    if (this.fallback) return "Canvas 2D 低 GPU 模式已启用";
    this.enableFallback();
    this.resize();
    return "WebGL 已安全释放；Canvas 2D 低 GPU 模式已启用";
  }

  destroy() {
    this.destroyed = true;
    this.pause();
    window.clearTimeout(this.contextRecoveryTimer);
    this.resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    this.canvas.removeEventListener("webglcontextlost", this.contextLossHandler);
    this.canvas.removeEventListener("webglcontextrestored", this.contextRestoreHandler);
    this.disposeWebGL({ loseContext: true });
    this.positions = null;
    this.homes = null;
    this.velocities = null;
  }

  dispose() {
    this.destroy();
  }
}

export function layoutForTool(index, count, world, role = "controller", activeIndex = Math.min(8, count - 1)) {
  const sideRole = role === "left" || role === "right";
  if (sideRole) {
    return { x: role === "left" ? 18 : 82, y: 16 + (index % 6) * 13.5, z: -4, rx: 0, ry: role === "left" ? 6 : -6, scale: 0.58, opacity: 0.92, layer: 16 - index, hero: false };
  }
  if (world === "starship_matrix") {
    const column = index % 2;
    const row = Math.floor(index / 2) % 6;
    const hero = index === activeIndex;
    return hero
      ? { x: 50, y: 54, z: 58, rx: 0, ry: 0, scale: 1.02, opacity: 1, layer: 40, hero: true }
      : { x: column ? 82 : 18, y: 18 + row * 13.5, z: -10 - row * 2, rx: 0, ry: column ? -6 : 6, scale: 0.56, opacity: 0.9, layer: 18 - row, hero: false };
  }
  if (world === "data_constellation") {
    const column = index % 4;
    const row = Math.floor(index / 4) % 3;
    const columns = [13, 38, 63, 88];
    const hero = index === activeIndex;
    return { x: columns[column], y: 26 + row * 25, z: hero ? 36 : (column + row) % 2 ? -12 : 6, rx: 0, ry: column < 2 ? 2.5 : -2.5, scale: hero ? 0.74 : 0.5, opacity: hero ? 1 : 0.88, layer: hero ? 32 : 14 - row, hero };
  }
  if (world === "liquid_prism") {
    const lane = index % 3;
    const row = Math.floor(index / 3) % 4;
    const hero = index === activeIndex;
    return hero
      ? { x: 52, y: 52, z: 48, rx: -1, ry: 0, scale: 0.92, opacity: 1, layer: 36, hero: true }
      : { x: 18 + lane * 34, y: 23 + row * 19, z: Math.round(Math.sin(index * 1.7) * 18), rx: lane - 1, ry: lane * 3 - 3, scale: 0.54, opacity: 0.9, layer: 16 - row, hero: false };
  }
  let distance = index - activeIndex;
  if (distance > count / 2) distance -= count;
  if (distance < -count / 2) distance += count;
  const step = Math.abs(distance);
  if (step === 0) {
    return { x: 54, y: 53, z: 58, rx: -1, ry: 0, scale: 1.02, opacity: 1, layer: 44, hero: true };
  }
  const xOffsets = [0, 29, 32, 34, 34, 32, 34];
  const yPositions = [53, 22, 35, 49, 63, 76, 86];
  const scales = [1.02, 0.66, 0.62, 0.59, 0.56, 0.53, 0.5];
  const opacities = [1, 0.96, 0.94, 0.92, 0.9, 0.88, 0.84];
  const direction = distance < 0 ? -1 : 1;
  const safeStep = Math.min(step, 6);
  return {
    x: 54 + direction * xOffsets[safeStep],
    y: yPositions[safeStep],
    z: 22 - safeStep * 8,
    rx: Math.max(-2.5, 0.5 - safeStep * 0.45),
    ry: direction * Math.min(8, safeStep * -1.45),
    scale: scales[safeStep],
    opacity: opacities[safeStep],
    layer: 30 - safeStep * 3,
    hero: false,
  };
}
