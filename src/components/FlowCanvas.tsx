import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { useFlowStore } from '../store/useFlowStore';
import { ease, lerp, nodePos, computeGeoFitTransform, MAX_LABELS } from '../lib/layout';
import { createEdgeGLRenderer, type EdgeGLRenderer } from '../lib/glEdges';
import { perspective, lookAt, multiply, transformPoint, screenToGround, type Mat4 } from '../lib/mat4';
import type { FlowEdge, FlowNode } from '../lib/types';

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  name: string;
  demand: number;
}

export function FlowCanvas({ onHover }: { onHover: (t: TooltipState) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const glRendererRef = useRef<EdgeGLRenderer | null>(null);
  const nodeIdxMapRef = useRef<Map<string, number>>(new Map());
  const rafRef = useRef<number>(0);

  // Mutable refs mirroring store, updated on every change but read inside rAF
  // loop without forcing React re-renders (canvas is imperative for perf).
  const modeRef = useRef(useFlowStore.getState().mode);
  const fromModeRef = useRef(useFlowStore.getState().mode);
  const transStartRef = useRef(performance.now());
  const hoverNodeRef = useRef<FlowNode | null>(null);
  const currentBlendRef = useRef(0);
  const visibleEdgesRef = useRef<FlowEdge[]>([]);
  const visibleNodesRef = useRef<FlowNode[]>([]);

  // Pan/zoom, like an actual map — positions are transformed at draw time,
  // radii/line-widths/font sizes are NOT scaled with zoom. That's what makes
  // zooming in actually declutter a dense cluster: node spacing grows while
  // the bubbles themselves stay a constant screen size.
  const viewRef = useRef({ scale: 1, tx: 0, ty: 0 });
  // The pan/zoom transform now animates IN SYNC with the position morph
  // instead of snapping instantly — snapping to the final geo-fit transform
  // while positions were still mid-blend (part arc, part geo) is what caused
  // the "arc disappears, geo suddenly pops in" effect: the viewport was
  // already framed for the final shape while looking at an in-between one.
  const viewStartRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const viewTargetRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const viewAnimatingRef = useRef(false);
  const draggingRef = useRef(false);

  // Orbit camera for Geo 3D mode: yaw/pitch around a fixed target, distance
  // controls zoom (dolly). Lazily initialized the first time 3D is turned
  // on, then persists across toggles within a session (switching back to
  // arc and returning to geo-3D doesn't reset your rotation).
  const camYawRef = useRef(0.6);
  const camPitchRef = useRef(0.55);
  const camDistRef = useRef(1000);
  const camTargetRef = useRef({ x: 0, z: 0 });
  const camInitializedRef = useRef(false);
  const orbitDraggingRef = useRef(false);
  const panDraggingRef = useRef(false);

  const PITCH_MIN = 0.12;
  const PITCH_MAX = 1.45;
  // Near-vertical but not exactly 90° (avoids gimbal lock) — this is the
  // "virtual camera" pitch that reproduces a flat top-down 2D view, used to
  // animate a smooth tilt between 2D and 3D instead of a hard cut.
  const FLAT_PITCH = 1.5;
  const CAM_FOV = (50 * Math.PI) / 180;

  interface CamState { yaw: number; pitch: number; dist: number; target: { x: number; z: number } }
  const geo3dAnimatingRef = useRef(false);
  const geo3dTransStartRef = useRef(0);
  const geo3dTransDuration = 1300;
  const geo3dCamStartRef = useRef<CamState>({ yaw: 0, pitch: FLAT_PITCH, dist: 1000, target: { x: 0, z: 0 } });
  const geo3dCamTargetRef = useRef<CamState>({ yaw: 0, pitch: 0.55, dist: 1000, target: { x: 0, z: 0 } });

  function initOrbitCamera(nodesArr: FlowNode[]) {
    if (nodesArr.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    nodesArr.forEach((n) => {
      minX = Math.min(minX, n.geo.x);
      maxX = Math.max(maxX, n.geo.x);
      minZ = Math.min(minZ, n.geo.y);
      maxZ = Math.max(maxZ, n.geo.y);
    });
    camTargetRef.current = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
    const diag = Math.max(Math.hypot(maxX - minX, maxZ - minZ), 100);
    camDistRef.current = diag * 0.85;
    camInitializedRef.current = true;
  }

  // A camera state that (approximately) reproduces the current flat 2D
  // pan/zoom as a very-steep-pitch perspective view — the "before" and
  // "after" endpoint for the 2D<->3D tilt animation.
  function computeFlatEquivalentCamera(W: number, H: number): CamState {
    const v = viewRef.current;
    const targetX = (W / 2 - v.tx) / v.scale;
    const targetZ = (H / 2 - v.ty) / v.scale;
    const dist = Math.max((H / (2 * Math.tan(CAM_FOV / 2))) / v.scale, 50);
    return { yaw: camYawRef.current, pitch: FLAT_PITCH, dist, target: { x: targetX, z: targetZ } };
  }

  function computeViewProjFrom(yaw: number, pitch: number, dist: number, target: { x: number; z: number }, W: number, H: number): Mat4 {
    const eye: [number, number, number] = [
      target.x + dist * Math.cos(pitch) * Math.sin(yaw),
      dist * Math.sin(pitch),
      target.z + dist * Math.cos(pitch) * Math.cos(yaw),
    ];
    const view = lookAt(eye, [target.x, 0, target.z], [0, 1, 0]);
    const proj = perspective(CAM_FOV, Math.max(W / H, 0.1), 1, Math.max(dist * 20, 5000));
    return multiply(proj, view);
  }

  function computeViewProj(W: number, H: number): Mat4 {
    return computeViewProjFrom(camYawRef.current, camPitchRef.current, camDistRef.current, camTargetRef.current, W, H);
  }

  function commitCurrentCameraIfAnimating() {
    if (!geo3dAnimatingRef.current) return;
    const now = performance.now();
    const p2 = Math.min((now - geo3dTransStartRef.current) / geo3dTransDuration, 1);
    const e2 = ease(p2);
    const s = geo3dCamStartRef.current, t = geo3dCamTargetRef.current;
    camYawRef.current = lerp(s.yaw, t.yaw, e2);
    camPitchRef.current = Math.min(PITCH_MAX, Math.max(PITCH_MIN, lerp(s.pitch, t.pitch, e2)));
    camDistRef.current = Math.exp(lerp(Math.log(s.dist), Math.log(t.dist), e2));
    camTargetRef.current = { x: lerp(s.target.x, t.target.x, e2), z: lerp(s.target.z, t.target.z, e2) };
    geo3dAnimatingRef.current = false;
  }

  function toScreen(p: { x: number; y: number }) {
    const v = viewRef.current;
    return { x: p.x * v.scale + v.tx, y: p.y * v.scale + v.ty };
  }

  function project3D(viewProj: Mat4, x: number, height: number, z: number, W: number, H: number) {
    const [cx, cy, cz, cw] = transformPoint(viewProj, x, height, z);
    if (cw <= 0.0001) return null; // behind the camera
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    return { x: (ndcX * 0.5 + 0.5) * W, y: (1 - (ndcY * 0.5 + 0.5)) * H, depth: cz / cw };
  }

  const transDuration = 1400;

  // GPU edge renderer lifecycle. If WebGL2 isn't available for some reason,
  // createEdgeGLRenderer returns null and the GL canvas just stays empty —
  // everything else (nodes, particles, labels, interaction) keeps working
  // on the 2D layer regardless.
  useEffect(() => {
    const glCanvas = glCanvasRef.current!;
    glRendererRef.current = createEdgeGLRenderer(glCanvas);
    return () => {
      glRendererRef.current?.destroy();
      glRendererRef.current = null;
    };
  }, []);

  // Recompute visible edges + visible nodes + particles + the GPU edge
  // buffer whenever the data that actually matters changes (dataset, topN,
  // palette/color scale). This is the only O(edges) work anywhere in this
  // component — guarded so it does NOT rerun on unrelated store updates
  // (typing in search, hovering, toggling mode), which matters a lot once
  // topN is in the tens of thousands.
  useEffect(() => {
    const recompute = () => {
      const { nodes, edgesRaw, topN, scales } = useFlowStore.getState();
      const n = Math.min(topN, edgesRaw.length);
      const sliced = edgesRaw.slice(0, n);

      const edges: FlowEdge[] = [];
      const nodeSet = new Map<string, FlowNode>();
      for (const e of sliced) {
        const s = nodes.get(e.sourceId);
        const t = nodes.get(e.targetId);
        if (!s || !t) continue;
        edges.push({ ...e, s, t });
        nodeSet.set(s.id, s);
        nodeSet.set(t.id, t);
      }
      visibleEdgesRef.current = edges;
      // Only draw stops that actually appear in the currently visible route
      // set — this is what stops the bubble pile-up when topN is capped:
      // previously every node in the whole dataset was drawn regardless of
      // how many edges were actually shown.
      visibleNodesRef.current = Array.from(nodeSet.values());

      // The actual GPU upload — a typed-array build + one bufferData call,
      // done once here rather than 60x/sec. This (not the render loop) is
      // where the "does 100k edges lag" question actually gets answered.
      // Particles are drawn from this SAME buffer (see glEdges.ts) — every
      // edge automatically gets flowing dots, no separate particle list to
      // build or cap.
      if (glRendererRef.current) {
        nodeIdxMapRef.current = glRendererRef.current.setEdges(nodes, sliced, scales);
      }
    };

    recompute();
    const unsub = useFlowStore.subscribe((state, prev) => {
      if (state.nodes !== prev.nodes || state.edgesRaw !== prev.edgesRaw || state.topN !== prev.topN || state.scales !== prev.scales) {
        recompute();
      }
    });
    return unsub;
  }, []);

  // Watch mode changes to trigger the arc<->geo morph transition, and reset
  // pan/zoom whenever a genuinely new dataset comes in (not on topN/filter
  // tweaks — those shouldn't yank the user's view around).
  useEffect(() => {
    const unsub = useFlowStore.subscribe((state, prev) => {
      if (state.mode !== prev.mode) {
        fromModeRef.current = prev.mode;
        modeRef.current = state.mode;
        transStartRef.current = performance.now();
        // Arc and geo use completely different coordinate layouts, so the
        // view needs to end up somewhere different for each — but instead
        // of jumping there instantly, animate from wherever the view
        // currently is toward that target, in sync with the position morph.
        const wrap = wrapRef.current;
        viewStartRef.current = { ...viewRef.current };
        viewTargetRef.current =
          state.mode === 'geo' && wrap
            ? computeGeoFitTransform(visibleNodesRef.current, wrap.clientWidth, wrap.clientHeight)
            : { scale: 1, tx: 0, ty: 0 };
        viewAnimatingRef.current = true;
      }
      if (state.edgesRaw !== prev.edgesRaw) {
        viewAnimatingRef.current = false;
        viewRef.current = { scale: 1, tx: 0, ty: 0 };
        camInitializedRef.current = false;
      }
      if (state.geo3D !== prev.geo3D) {
        const wrap = wrapRef.current;
        if (wrap) {
          const W = wrap.clientWidth, H = wrap.clientHeight;
          if (state.geo3D) {
            // Turning ON: tilt FROM a virtual flat camera matching the
            // current 2D view TO the orbit camera — reads as the map
            // physically tilting up into 3D, not a jump cut.
            if (!camInitializedRef.current) initOrbitCamera(visibleNodesRef.current);
            geo3dCamStartRef.current = computeFlatEquivalentCamera(W, H);
            geo3dCamTargetRef.current = {
              yaw: camYawRef.current, pitch: camPitchRef.current,
              dist: camDistRef.current, target: { ...camTargetRef.current },
            };
          } else {
            // Turning OFF: tilt FROM the current orbit camera back TO the
            // flat view we'll land on, same idea in reverse.
            geo3dCamStartRef.current = {
              yaw: camYawRef.current, pitch: camPitchRef.current,
              dist: camDistRef.current, target: { ...camTargetRef.current },
            };
            geo3dCamTargetRef.current = computeFlatEquivalentCamera(W, H);
          }
          geo3dTransStartRef.current = performance.now();
          geo3dAnimatingRef.current = true;
        }
      }
    });
    return unsub;
  }, []);

  // Resize handling
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;

    function resize() {
      const wrap = wrapRef.current!;
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      const DPR = Math.min(window.devicePixelRatio || 1, 4);
      canvas.width = W * DPR;
      canvas.height = H * DPR;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      glRendererRef.current?.resize(W, H, DPR);
      useFlowStore.getState().setCanvasSize(W, H);
    }
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // Main render loop
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;

    function drawLabel(
      ctx2: CanvasRenderingContext2D,
      text: string,
      x: number,
      y: number,
      dx: number,
      dy: number,
      align: CanvasTextAlign,
      angle: number,
      bold: boolean,
      color: string
    ) {
      ctx2.save();
      ctx2.translate(x + dx, y + dy);
      if (angle) ctx2.rotate(angle);
      ctx2.font = (bold ? '600 11px' : '500 10px') + " 'Inter', sans-serif";
      ctx2.textAlign = align;
      ctx2.fillStyle = color;
      ctx2.fillText(text, 0, 0);
      ctx2.restore();
    }

    function draw(now: number) {
      const { filterText, scales, mode, geo3D } = useFlowStore.getState();
      const wrap = wrapRef.current!;
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      const is3D = mode === 'geo' && (geo3D || geo3dAnimatingRef.current);

      const progress = Math.min((now - transStartRef.current) / transDuration, 1);
      const easedProgress = ease(progress);
      const fromBlend = fromModeRef.current === 'geo' ? 1 : 0;
      const toBlend = modeRef.current === 'geo' ? 1 : 0;
      const blend = is3D ? 1 : lerp(fromBlend, toBlend, easedProgress);
      currentBlendRef.current = blend;
      if (progress >= 1) fromModeRef.current = modeRef.current;

      if (!is3D && viewAnimatingRef.current) {
        const vs = viewStartRef.current;
        const vt = viewTargetRef.current;
        // The logical point currently sitting at canvas-center, for each end
        // of the transition — this is what we keep anchored to center
        // throughout, rather than independently interpolating scale/tx/ty
        // (which has no fixed anchor and can visually "swim" mid-transition,
        // reading as a dip/jerk).
        const focusStartX = (W / 2 - vs.tx) / vs.scale;
        const focusStartY = (H / 2 - vs.ty) / vs.scale;
        const focusTargetX = (W / 2 - vt.tx) / vt.scale;
        const focusTargetY = (H / 2 - vt.ty) / vt.scale;

        // Scale eases in LOG space — matches how the manual wheel-zoom
        // already feels (exponential), and avoids the sudden speed change a
        // linear scale lerp produces when start/target scales differ a lot.
        const scale = Math.exp(lerp(Math.log(vs.scale), Math.log(vt.scale), easedProgress));
        const focusX = lerp(focusStartX, focusTargetX, easedProgress);
        const focusY = lerp(focusStartY, focusTargetY, easedProgress);

        viewRef.current = { scale, tx: W / 2 - focusX * scale, ty: H / 2 - focusY * scale };
        if (progress >= 1) viewAnimatingRef.current = false;
      }

      ctx.clearRect(0, 0, W, H);

      const highlight = filterText.trim().toLowerCase();
      const hoverId = hoverNodeRef.current ? hoverNodeRef.current.id : null;
      const hoverIdx = hoverId !== null ? nodeIdxMapRef.current.get(hoverId) ?? -1 : -1;

      ctx.lineCap = 'round';

      let viewProj: Mat4 | null = null;
      if (is3D) {
        if (!camInitializedRef.current) initOrbitCamera(visibleNodesRef.current);
        let yaw = camYawRef.current, pitch = camPitchRef.current, dist = camDistRef.current, target = camTargetRef.current;
        if (geo3dAnimatingRef.current) {
          const p2 = Math.min((now - geo3dTransStartRef.current) / geo3dTransDuration, 1);
          const e2 = ease(p2);
          const s = geo3dCamStartRef.current, t = geo3dCamTargetRef.current;
          yaw = lerp(s.yaw, t.yaw, e2);
          pitch = lerp(s.pitch, t.pitch, e2);
          // Distance eases in log space — same rationale as the 2D
          // pan/zoom transition: matches how zoom already feels and avoids
          // a sudden speed change when start/target distances differ a lot.
          dist = Math.exp(lerp(Math.log(s.dist), Math.log(t.dist), e2));
          target = { x: lerp(s.target.x, t.target.x, e2), z: lerp(s.target.z, t.target.z, e2) };
          if (p2 >= 1) {
            geo3dAnimatingRef.current = false;
            camYawRef.current = t.yaw;
            camPitchRef.current = t.pitch;
            camDistRef.current = t.dist;
            camTargetRef.current = t.target;
          }
        }
        viewProj = computeViewProjFrom(yaw, pitch, dist, target, W, H);
        glRendererRef.current?.draw3D({
          viewProj, heightScale: 0.35, width: W, height: H, hoverIdx, time: now / 1000,
        });
      } else {
        // edges + particles — two GPU draw calls total for every edge,
        // regardless of count. Morph blend, pan/zoom, hover-dim, and
        // particle animation (via uTime) are all uniforms; no per-edge or
        // per-particle JS work happens here at all.
        glRendererRef.current?.draw({
          blend, scale: viewRef.current.scale, tx: viewRef.current.tx, ty: viewRef.current.ty,
          width: W, height: H, hoverIdx, time: now / 1000,
        });
      }

      // nodes — only the ones referenced by currently visible edges
      const nodesArr = visibleNodesRef.current;
      // Labels were collision-avoided once at the base (1x) layout scale.
      // Zooming out packs bubbles closer together on screen (radius stays
      // constant, spacing shrinks) so a layout that was collision-free at 1x
      // isn't necessarily collision-free below it — hence "labels overlapping
      // bubbles when zoomed out." Rather than re-running collision detection
      // every frame, only show the top-ranked N labels, where N scales with
      // the current zoom: fewer when zoomed out, all of them (and no more
      // than were ever placed) once zoomed in enough to have room.
      const labelBudget = Math.max(6, Math.round(MAX_LABELS * Math.min(1.4, viewRef.current.scale)));
      nodesArr.forEach((n) => {
        const r = scales.radiusScale(n.demand);
        let p: { x: number; y: number } | null;
        let stemBase: { x: number; y: number } | null = null;
        if (is3D && viewProj) {
          // Nodes float above the ground plane by a modest amount tied to
          // demand — the "skyline" cue — with a thin stem connecting the
          // floating bubble back down to its actual ground position.
          const nodeHeight = r * 4;
          p = project3D(viewProj, n.geo.x, nodeHeight, n.geo.y, W, H);
          stemBase = project3D(viewProj, n.geo.x, 0, n.geo.y, W, H);
          if (!p) return; // behind the camera this frame
        } else {
          p = toScreen(nodePos(n, blend));
        }
        const isHot = hoverId === n.id;
        const isSearchHit = highlight && n.name.toLowerCase().includes(highlight);
        const dim = hoverId && !isHot;
        const col = isSearchHit ? '#0ea5a8' : scales.nodeColorScale(n.demand);

        if (!p) return;

        if (stemBase) {
          ctx.beginPath();
          ctx.moveTo(stemBase.x, stemBase.y);
          ctx.lineTo(p.x, p.y);
          ctx.strokeStyle = col;
          ctx.globalAlpha = dim ? 0.05 : 0.4;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        const isHotOrHit = isHot || isSearchHit;
        if (isHotOrHit) {
          ctx.globalAlpha = 0.28;
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 1.55, 0, Math.PI * 2);
          ctx.fill();
        }

        const drawR = isHotOrHit ? r * 1.15 : r;
        ctx.beginPath();
        ctx.arc(p.x, p.y, drawR, 0, Math.PI * 2);
        ctx.fillStyle = col;
        // Non-hovered nodes fade to nearly nothing (was 0.07) — present,
        // but barely visible — while the selected/hovered node stays fully
        // opaque and gets a slightly larger radius so it clearly reads as
        // "this one."
        ctx.globalAlpha = dim ? 0.035 : 1;
        ctx.fill();
        if (isHotOrHit) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // Hover/search always gets a label, live, regardless of the
        // precomputed static layout. Otherwise fall back to the
        // collision-avoided placement computed once in computeLayouts — not
        // meaningful in 3D (those offsets assume a flat screen layout), so
        // only hover/search labels show there.
        if (isHotOrHit) {
          const ty = mode === 'arc' ? r + 14 : 0;
          const tx = mode === 'arc' ? 0 : r + 6;
          const align: CanvasTextAlign = mode === 'arc' ? 'center' : 'left';
          const text = n.name.length > 26 ? n.name.slice(0, 24) + '…' : n.name;
          drawLabel(ctx, text, p.x, p.y, tx, ty, align, 0, true, '#0b1220');
        } else if (!is3D) {
          const label = mode === 'geo' ? n.geoLabel : n.arcLabel;
          if (label?.show && label.rank < labelBudget) {
            drawLabel(ctx, label.text, p.x, p.y, label.dx, label.dy, label.align, label.angle, false, dim ? 'rgba(107,118,134,0.05)' : '#0b1220');
          }
        }
      });

      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // Mouse interaction: hover, wheel-zoom, drag-pan, double-click reset —
  // this is what makes a dense cluster of overlapping stops actually
  // navigable instead of a static wall of bubbles.
  useEffect(() => {
    const canvas = canvasRef.current!;
    let dragStart = { x: 0, y: 0 };
    let viewStart = { tx: 0, ty: 0 };
    let orbitStart = { yaw: 0, pitch: 0 };
    let lastPanGround: { x: number; z: number } | null = null;

    function is3DActive() {
      const { mode, geo3D } = useFlowStore.getState();
      return mode === 'geo' && geo3D;
    }

    function onHoverMove(mx: number, my: number) {
      const { scales } = useFlowStore.getState();
      let found: FlowNode | null = null;
      let best = Infinity;
      if (is3DActive()) {
        const wrap = wrapRef.current!;
        const viewProj = computeViewProj(wrap.clientWidth, wrap.clientHeight);
        visibleNodesRef.current.forEach((n) => {
          const r = scales.radiusScale(n.demand);
          const p = project3D(viewProj, n.geo.x, r * 4, n.geo.y, wrap.clientWidth, wrap.clientHeight);
          if (!p) return;
          const d = Math.hypot(mx - p.x, my - p.y);
          if (d < r + 6 && d < best) {
            best = d;
            found = n;
          }
        });
      } else {
        visibleNodesRef.current.forEach((n) => {
          const p = toScreen(nodePos(n, currentBlendRef.current));
          const r = scales.radiusScale(n.demand) + 4;
          const d = Math.hypot(mx - p.x, my - p.y);
          if (d < r && d < best) {
            best = d;
            found = n;
          }
        });
      }
      hoverNodeRef.current = found;
      if (found) {
        const f: FlowNode = found;
        onHover({ visible: true, x: mx, y: my, name: f.name, demand: f.demand });
      } else {
        onHover({ visible: false, x: mx, y: my, name: '', demand: 0 });
      }
    }

    function onMove(e: MouseEvent) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (panDraggingRef.current) {
        // Standard "grab the ground and drag" pan: raycast the current
        // mouse position to the ground plane and shift the camera target by
        // exactly the delta since the last move event — same technique used
        // by Mapbox/Google Maps, and what makes panning feel anchored to
        // the terrain instead of an arbitrary fixed sensitivity.
        const wrap = wrapRef.current!;
        const W = wrap.clientWidth, H = wrap.clientHeight;
        const viewProj = computeViewProj(W, H);
        const nowGround = screenToGround(viewProj, mx, my, W, H);
        if (nowGround && lastPanGround) {
          camTargetRef.current = {
            x: camTargetRef.current.x - (nowGround.x - lastPanGround.x),
            z: camTargetRef.current.z - (nowGround.z - lastPanGround.z),
          };
        }
        lastPanGround = screenToGround(computeViewProj(W, H), mx, my, W, H);
        onHover({ visible: false, x: mx, y: my, name: '', demand: 0 });
        return;
      }
      if (orbitDraggingRef.current) {
        const dx = e.clientX - dragStart.x;
        const dy = e.clientY - dragStart.y;
        camYawRef.current = orbitStart.yaw + dx * 0.006;
        camPitchRef.current = Math.min(PITCH_MAX, Math.max(PITCH_MIN, orbitStart.pitch - dy * 0.006));
        onHover({ visible: false, x: mx, y: my, name: '', demand: 0 });
        return;
      }
      if (draggingRef.current) {
        const v = viewRef.current;
        v.tx = viewStart.tx + (e.clientX - dragStart.x);
        v.ty = viewStart.ty + (e.clientY - dragStart.y);
        onHover({ visible: false, x: mx, y: my, name: '', demand: 0 });
        return;
      }
      onHoverMove(mx, my);
    }

    function onLeave() {
      if (!draggingRef.current && !orbitDraggingRef.current && !panDraggingRef.current) hoverNodeRef.current = null;
      onHover({ visible: false, x: 0, y: 0, name: '', demand: 0 });
    }

    function onDown(e: MouseEvent) {
      viewAnimatingRef.current = false;
      hoverNodeRef.current = null;
      if (is3DActive()) {
        commitCurrentCameraIfAnimating();
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        if (e.button === 2) {
          // Right-drag: orbit/tilt — standard 3D-map convention.
          orbitDraggingRef.current = true;
          dragStart = { x: e.clientX, y: e.clientY };
          orbitStart = { yaw: camYawRef.current, pitch: camPitchRef.current };
          canvas.style.cursor = 'grabbing';
        } else {
          // Left-drag: pan the ground — standard 3D-map convention.
          const wrap = wrapRef.current!;
          panDraggingRef.current = true;
          lastPanGround = screenToGround(computeViewProj(wrap.clientWidth, wrap.clientHeight), mx, my, wrap.clientWidth, wrap.clientHeight);
          canvas.style.cursor = 'grabbing';
        }
        return;
      }
      draggingRef.current = true;
      dragStart = { x: e.clientX, y: e.clientY };
      viewStart = { tx: viewRef.current.tx, ty: viewRef.current.ty };
      canvas.style.cursor = 'grabbing';
    }

    function onUp() {
      draggingRef.current = false;
      orbitDraggingRef.current = false;
      panDraggingRef.current = false;
      lastPanGround = null;
      canvas.style.cursor = 'grab';
    }

    function onContextMenu(e: MouseEvent) {
      if (is3DActive()) e.preventDefault(); // right-click is a drag gesture in 3D, not a menu
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      viewAnimatingRef.current = false;
      if (is3DActive()) {
        commitCurrentCameraIfAnimating();
        const factor = Math.exp(e.deltaY * 0.0015);
        camDistRef.current = Math.min(50000, Math.max(50, camDistRef.current * factor));
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const v = viewRef.current;
      const logX = (mx - v.tx) / v.scale;
      const logY = (my - v.ty) / v.scale;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newScale = Math.min(10, Math.max(0.5, v.scale * factor));
      viewRef.current = { scale: newScale, tx: mx - logX * newScale, ty: my - logY * newScale };
    }

    function onDblClick() {
      viewAnimatingRef.current = false;
      if (is3DActive()) {
        geo3dAnimatingRef.current = false;
        camYawRef.current = 0.6;
        camPitchRef.current = 0.55;
        initOrbitCamera(visibleNodesRef.current);
        return;
      }
      viewRef.current = { scale: 1, tx: 0, ty: 0 };
    }

    canvas.style.cursor = 'grab';
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);
    window.addEventListener('mouseup', onUp);
    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onHover]);

  const mode = useFlowStore((s) => s.mode);
  const geo3D = useFlowStore((s) => s.geo3D);
  const is3DHint = mode === 'geo' && geo3D;

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas ref={glCanvasRef} className="gl-layer" />
      <canvas ref={canvasRef} />
      <div className="zoom-hint">
        {is3DHint ? 'drag to pan · right-drag to orbit · scroll to zoom · double-click to reset' : 'scroll to zoom · drag to pan · double-click to reset'}
      </div>
    </div>
  );
}

export const fmt = d3.format(',');