import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { useFlowStore } from '../store/useFlowStore';
import { ease, lerp, nodePos, computeGeoFitTransform, MAX_LABELS } from '../lib/layout';
import { createEdgeGLRenderer, type EdgeGLRenderer } from '../lib/glEdges';
import { perspective, lookAt, multiply, transformPoint, screenToGround, type Mat4 } from '../lib/mat4';
import type { FlowEdge, FlowNode, ViewMode } from '../lib/types';

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
  // Vertical fly offset — layered on top of the orbit camera so WASD/QE
  // flight (below) can lift/lower the whole rig without disturbing the
  // orbit's own yaw/pitch/dist/target math. Always reset to 0 whenever a
  // mode/3D transition starts (see beginCrossModeTransition).
  const camElevRef = useRef(0);
  const camInitializedRef = useRef(false);
  const orbitDraggingRef = useRef(false);
  const panDraggingRef = useRef(false);
  // Cinematic WASD(+QE)/arrow flight, active only while steady in 3D (not
  // mid tilt-transition). Held keys accumulate into a smoothed velocity —
  // eased in and out — rather than snapping straight to full speed, so the
  // camera glides rather than jerks.
  const flightKeysRef = useRef<Set<string>>(new Set());
  const flightVelRef = useRef({ x: 0, z: 0, y: 0 });
  const lastFrameTimeRef = useRef(performance.now());
  // Auto Cinema — the camera flies itself: a slow constant orbit plus a
  // gentle re-center on whatever data is currently visible, so it never
  // drifts off to stare at empty space even as topN/filtering changes what's
  // on screen.
  const cinemaIdealRef = useRef<{ target: { x: number; z: number }; dist: number } | null>(null);
  const cinemaIdealComputedAtRef = useRef(0);

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
  // When leaving 3D happens together with an arc<->geo mode switch (e.g.
  // 3D was left on, then the user taps back to Arc), the camera tilts back
  // down FIRST; only once that finishes do we start the flat position morph
  // (see draw()) — running both at once was the "pop" that made this feel
  // unsmooth, since node markers are drawn from raw geo coords the whole
  // time the camera is still 3D, independent of how far the position-morph
  // clock had silently progressed underneath.
  const pendingPositionMorphRef = useRef(false);
  // If the user has scrolled/panned/orbited somewhere arbitrary before
  // switching modes, jumping straight into the cross-mode morph from THAT
  // extent reads as a jarring "re-zoom + reshape at once." Instead: first
  // ease back to a neutral extent in the CURRENT mode/dimension, then run
  // the normal cross-mode transition from there. `pendingCrossModeRef` holds
  // the real transition to run once that reset finishes; `renderOverrideRef`
  // pins rendering to the OLD mode/3D-ness while the reset plays, since the
  // store's mode/geo3D already flip the instant the user clicks.
  const pendingCrossModeRef = useRef<null | { fromMode: ViewMode; fromGeo3D: boolean; toMode: ViewMode; toGeo3D: boolean }>(null);
  const renderOverrideRef = useRef<null | { mode: ViewMode; geo3D: boolean }>(null);

  // The "neutral" orbit camera for a set of nodes — centered and dollied
  // back to fit them all, at whatever yaw/pitch is passed in. Pure (no ref
  // writes) so it doubles as both the initializer AND the reset-phase target.
  function defaultCamFor(nodesArr: FlowNode[], yaw: number, pitch: number): CamState {
    if (nodesArr.length === 0) {
      return { yaw, pitch, dist: camDistRef.current, target: { ...camTargetRef.current } };
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    nodesArr.forEach((n) => {
      minX = Math.min(minX, n.geo.x);
      maxX = Math.max(maxX, n.geo.x);
      minZ = Math.min(minZ, n.geo.y);
      maxZ = Math.max(maxZ, n.geo.y);
    });
    const target = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
    const diag = Math.max(Math.hypot(maxX - minX, maxZ - minZ), 100);
    return { yaw, pitch, dist: diag * 0.85, target };
  }

  function initOrbitCamera(nodesArr: FlowNode[]) {
    if (nodesArr.length === 0) return;
    const def = defaultCamFor(nodesArr, camYawRef.current, camPitchRef.current);
    camTargetRef.current = def.target;
    camDistRef.current = def.dist;
    camInitializedRef.current = true;
  }

  // A camera state that (approximately) reproduces the current flat 2D
  // pan/zoom as a very-steep-pitch perspective view — the "before" and
  // "after" endpoint for the 2D<->3D tilt animation.
  function computeFlatEquivalentCamera(v: { scale: number; tx: number; ty: number }, W: number, H: number): CamState {
    const targetX = (W / 2 - v.tx) / v.scale;
    const targetZ = (H / 2 - v.ty) / v.scale;
    const dist = Math.max((H / (2 * Math.tan(CAM_FOV / 2))) / v.scale, 50);
    return { yaw: camYawRef.current, pitch: FLAT_PITCH, dist, target: { x: targetX, z: targetZ } };
  }

  // Auto Cinema — a slow, self-driving orbit that always keeps the current
  // data centered and comfortably framed, rather than just spinning in
  // place around wherever the camera happened to be left.
  function applyCinema(dt: number, now: number) {
    // Recomputing the "ideal" framing walks every visible node — cheap to
    // ease toward each frame, wasteful to recompute from scratch 60x/sec.
    // Once a second is plenty to track topN/filter changes smoothly.
    if (!cinemaIdealRef.current || now - cinemaIdealComputedAtRef.current > 1000) {
      cinemaIdealComputedAtRef.current = now;
      cinemaIdealRef.current = defaultCamFor(visibleNodesRef.current, 0, 0);
    }
    const ideal = cinemaIdealRef.current;
    if (ideal) {
      // This is what keeps the "correct angle" promise: continuously ease
      // the look-at point and distance toward a framing that fits whatever
      // is actually on screen right now, so the fly-through is always
      // looking at the data, never off into empty space.
      const k = 1 - Math.exp(-dt / 2.2);
      camTargetRef.current = {
        x: lerp(camTargetRef.current.x, ideal.target.x, k),
        z: lerp(camTargetRef.current.z, ideal.target.z, k),
      };
      camDistRef.current = Math.exp(lerp(Math.log(Math.max(camDistRef.current, 1)), Math.log(Math.max(ideal.dist, 50)), k));
    }
    // Slow constant orbit (~1 revolution every 2.5 minutes) plus a gentle
    // pitch "breathe" so it reads as deliberate camera work, not a robot
    // spinning on an axis.
    camYawRef.current += dt * ((Math.PI * 2) / 150);
    const pitchCenter = 0.5, pitchAmp = 0.12, pitchPeriodSec = 40;
    const pitch = pitchCenter + Math.sin((now / 1000) * ((Math.PI * 2) / pitchPeriodSec)) * pitchAmp;
    camPitchRef.current = Math.min(PITCH_MAX, Math.max(PITCH_MIN, pitch));
    // Settle back to ground level if manual flight had lifted the rig
    // before cinema mode was turned on.
    camElevRef.current = lerp(camElevRef.current, 0, 1 - Math.exp(-dt / 2));
  }

  // Smooth WASD(+QE)/arrow-key flight for the orbit camera — held keys ease
  // toward a target velocity (and back to zero on release) rather than
  // snapping, which is what makes it read as a cinematic glide instead of a
  // jog. Speed scales with the current orbit distance so it feels the same
  // relative pace whether zoomed in tight or looking at the whole map.
  function applyFlight(dt: number) {
    const keys = flightKeysRef.current;
    if (keys.size === 0 && Math.hypot(flightVelRef.current.x, flightVelRef.current.z, flightVelRef.current.y) < 0.5) {
      flightVelRef.current = { x: 0, z: 0, y: 0 };
      return;
    }
    const forward = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
    const strafe = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    const vert = (keys.has('e') || keys.has('pageup') ? 1 : 0) - (keys.has('q') || keys.has('pagedown') ? 1 : 0);

    const yaw = camYawRef.current;
    // "Forward" is toward where the camera is looking on the ground plane —
    // matches the eye/target relationship in computeViewProjFrom.
    const fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw), rightZ = -Math.sin(yaw);

    const speed = camDistRef.current * 0.4; // world units/sec, scales with zoom
    const desiredX = (fwdX * forward + rightX * strafe) * speed;
    const desiredZ = (fwdZ * forward + rightZ * strafe) * speed;
    const desiredY = vert * speed * 0.6;

    // Exponential smoothing toward the desired velocity — a ~0.45s time
    // constant so starting/stopping glides rather than snaps.
    const k = 1 - Math.exp(-dt / 0.45);
    const v = flightVelRef.current;
    v.x = lerp(v.x, desiredX, k);
    v.z = lerp(v.z, desiredZ, k);
    v.y = lerp(v.y, desiredY, k);

    camTargetRef.current = { x: camTargetRef.current.x + v.x * dt, z: camTargetRef.current.z + v.z * dt };
    camElevRef.current += v.y * dt;
  }

  function computeViewProjFrom(yaw: number, pitch: number, dist: number, target: { x: number; z: number }, W: number, H: number, elev = 0): Mat4 {
    const eye: [number, number, number] = [
      target.x + dist * Math.cos(pitch) * Math.sin(yaw),
      dist * Math.sin(pitch) + elev,
      target.z + dist * Math.cos(pitch) * Math.cos(yaw),
    ];
    const view = lookAt(eye, [target.x, elev, target.z], [0, 1, 0]);
    const proj = perspective(CAM_FOV, Math.max(W / H, 0.1), 1, Math.max(dist * 20, 5000));
    return multiply(proj, view);
  }

  function computeViewProj(W: number, H: number): Mat4 {
    return computeViewProjFrom(camYawRef.current, camPitchRef.current, camDistRef.current, camTargetRef.current, W, H, camElevRef.current);
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
    if (pendingCrossModeRef.current) {
      // Interrupted mid-reset — skip straight to the real transition rather
      // than leaving it stuck pending (and rendering pinned to the old mode)
      // forever.
      const pc = pendingCrossModeRef.current;
      pendingCrossModeRef.current = null;
      beginCrossModeTransition(pc.fromMode, pc.fromGeo3D, pc.toMode, pc.toGeo3D);
      return;
    }
    // If the user grabs the map mid-tilt (interrupting the animation
    // early), still fire the deferred position morph rather than leaving it
    // stuck pending forever.
    if (pendingPositionMorphRef.current) {
      pendingPositionMorphRef.current = false;
      const wrap = wrapRef.current;
      if (wrap) {
        transStartRef.current = now;
        viewStartRef.current = { ...viewRef.current };
        viewTargetRef.current =
          modeRef.current === 'geo'
            ? computeGeoFitTransform(visibleNodesRef.current, wrap.clientWidth, wrap.clientHeight)
            : { scale: 1, tx: 0, ty: 0 };
        viewAnimatingRef.current = true;
      }
    }
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
      const { nodes, edgesRaw, topN, scales, selectedNodeId } = useFlowStore.getState();
      const capped = edgesRaw.slice(0, Math.min(topN, edgesRaw.length));
      // Selecting a tower's bulb isolates the view to just the routes
      // touching that stop — filtered from the SAME capped topN set hover
      // already highlights from, not the full raw dataset. Pulling from the
      // uncapped data here would surface routes that were never visible in
      // the first place (hidden by the topN cap), so a hub stop would
      // suddenly show dozens of "new" connections on click that never
      // showed up on hover — looking fabricated even though it's real data.
      const sliced = selectedNodeId
        ? capped.filter((e) => e.sourceId === selectedNodeId || e.targetId === selectedNodeId)
        : capped;

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
      // Isolating a stop with no routes at all would otherwise vanish
      // entirely (no edges touch it) — keep it drawable on its own.
      if (selectedNodeId && !nodeSet.has(selectedNodeId)) {
        const solo = nodes.get(selectedNodeId);
        if (solo) nodeSet.set(solo.id, solo);
      }
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
      if (
        state.nodes !== prev.nodes ||
        state.edgesRaw !== prev.edgesRaw ||
        state.topN !== prev.topN ||
        state.scales !== prev.scales ||
        state.selectedNodeId !== prev.selectedNodeId
      ) {
        recompute();
      }
    });
    return unsub;
  }, []);

  // Runs the actual cross-mode transition (2D blend and/or 3D tilt) FROM
  // whatever the current view/camera is — callers are responsible for
  // making sure that's already a neutral extent (see the mode-change
  // subscribe effect below, which stages a reset first when it isn't, and
  // draw(), which calls this again once that reset finishes).
  function beginCrossModeTransition(fromMode: ViewMode, fromGeo3D: boolean, toMode: ViewMode, toGeo3D: boolean) {
    camElevRef.current = 0;
    flightVelRef.current = { x: 0, z: 0, y: 0 };
    cinemaIdealRef.current = null;
    const modeChanged = fromMode !== toMode;
    // "Effective" 3D-ness — true only when we're actually in geo mode AND
    // the 3D toggle is on. This can flip via EITHER flag: toggling the 3D
    // button, or switching Arc<->Geo while 3D was already left on from an
    // earlier session (the toggle button hides in Arc mode, but the
    // underlying geo3D flag doesn't reset). Both cases need the same smooth
    // camera tilt, not a snap.
    const prevEff3D = fromMode === 'geo' && fromGeo3D;
    const newEff3D = toMode === 'geo' && toGeo3D;
    const eff3DChanged = prevEff3D !== newEff3D;
    // Turning 3D off while ALSO switching modes: don't start the flat
    // arc<->geo position morph yet — defer it until the camera finishes
    // tilting back down (handled in draw()), so the two animations run one
    // after another instead of racing each other.
    const deferPositionMorph = modeChanged && eff3DChanged && !newEff3D;

    if (modeChanged) {
      fromModeRef.current = fromMode;
      modeRef.current = toMode;
      if (deferPositionMorph) {
        pendingPositionMorphRef.current = true;
      } else {
        transStartRef.current = performance.now();
        // Arc and geo use completely different coordinate layouts, so the
        // view needs to end up somewhere different for each — but instead
        // of jumping there instantly, animate from wherever the view
        // currently is toward that target, in sync with the position morph.
        const wrap = wrapRef.current;
        viewStartRef.current = { ...viewRef.current };
        viewTargetRef.current =
          toMode === 'geo' && wrap
            ? computeGeoFitTransform(visibleNodesRef.current, wrap.clientWidth, wrap.clientHeight)
            : { scale: 1, tx: 0, ty: 0 };
        viewAnimatingRef.current = true;
      }
    }
    if (eff3DChanged) {
      const wrap = wrapRef.current;
      if (wrap) {
        const W = wrap.clientWidth, H = wrap.clientHeight;
        if (newEff3D) {
          // Turning ON: tilt FROM a virtual flat camera matching the
          // current 2D view TO the orbit camera — reads as the map
          // physically tilting up into 3D, not a jump cut.
          if (!camInitializedRef.current) initOrbitCamera(visibleNodesRef.current);
          geo3dCamStartRef.current = computeFlatEquivalentCamera(viewRef.current, W, H);
          geo3dCamTargetRef.current = {
            yaw: camYawRef.current, pitch: camPitchRef.current,
            dist: camDistRef.current, target: { ...camTargetRef.current },
          };
        } else {
          // Turning OFF: tilt FROM the current orbit camera back TO the
          // flat view we'll land on. If the mode is changing in the same
          // update, aim for where that view is HEADING; deferPositionMorph
          // means that's simply Arc's default reset transform (the only
          // other mode). Otherwise (a plain 3D-toggle-off while staying in
          // Geo) aim at the current 2D view.
          geo3dCamStartRef.current = {
            yaw: camYawRef.current, pitch: camPitchRef.current,
            dist: camDistRef.current, target: { ...camTargetRef.current },
          };
          const refView = deferPositionMorph ? { scale: 1, tx: 0, ty: 0 } : viewRef.current;
          geo3dCamTargetRef.current = computeFlatEquivalentCamera(refView, W, H);
        }
        geo3dTransStartRef.current = performance.now();
        geo3dAnimatingRef.current = true;
      }
    }
    // From here on, render exactly what the store says — no more pinning to
    // the pre-transition mode/3D-ness.
    renderOverrideRef.current = null;
  }

  // Watch mode changes to trigger the arc<->geo morph transition, and reset
  // pan/zoom whenever a genuinely new dataset comes in (not on topN/filter
  // tweaks — those shouldn't yank the user's view around).
  useEffect(() => {
    const unsub = useFlowStore.subscribe((state, prev) => {
      if (state.edgesRaw !== prev.edgesRaw) {
        viewAnimatingRef.current = false;
        viewRef.current = { scale: 1, tx: 0, ty: 0 };
        camInitializedRef.current = false;
        pendingCrossModeRef.current = null;
        renderOverrideRef.current = null;
      }
      if (state.mode === prev.mode && state.geo3D === prev.geo3D) return;

      const fromMode = prev.mode, fromGeo3D = prev.geo3D;
      const toMode = state.mode, toGeo3D = state.geo3D;
      const fromEff3D = fromMode === 'geo' && fromGeo3D;
      const toEff3D = toMode === 'geo' && toGeo3D;
      // Cinema only makes sense in 3D — if the user (or anything else)
      // steers back out of it, stop the autopilot rather than leaving it
      // silently armed to resume next time 3D comes back.
      if (fromEff3D && !toEff3D && state.cinemaMode) {
        useFlowStore.getState().setCinemaMode(false);
      }
      const wrap = wrapRef.current;

      // Has the user scrolled/panned/orbited noticeably away from a neutral
      // framing in whatever we're CURRENTLY showing? If so, ease back to
      // neutral first, in the same mode/dimension, THEN run the cross-mode
      // transition — one visual change at a time instead of a zoom-jump and
      // a reshape happening on top of each other.
      let needsReset = false;
      if (wrap) {
        const W = wrap.clientWidth, H = wrap.clientHeight;
        if (fromEff3D) {
          const def = defaultCamFor(visibleNodesRef.current, camYawRef.current, camPitchRef.current);
          const distRatio = camDistRef.current / Math.max(def.dist, 1);
          const targetOff = Math.hypot(camTargetRef.current.x - def.target.x, camTargetRef.current.z - def.target.z);
          needsReset = distRatio < 0.6 || distRatio > 1.7 || targetOff > def.dist * 0.5;
        } else {
          const def = fromMode === 'geo' ? computeGeoFitTransform(visibleNodesRef.current, W, H) : { scale: 1, tx: 0, ty: 0 };
          const v = viewRef.current;
          const scaleRatio = v.scale / Math.max(def.scale, 0.0001);
          needsReset = scaleRatio < 0.7 || scaleRatio > 1.4 || Math.abs(v.tx - def.tx) > 40 || Math.abs(v.ty - def.ty) > 40;
        }
      }

      if (needsReset && wrap) {
        const W = wrap.clientWidth, H = wrap.clientHeight;
        // Stash the REAL transition for later, and pin rendering to the old
        // mode/3D-ness while the reset plays (the store already flipped).
        pendingCrossModeRef.current = { fromMode, fromGeo3D, toMode, toGeo3D };
        renderOverrideRef.current = { mode: fromMode, geo3D: fromGeo3D };
        if (fromEff3D) {
          const def = defaultCamFor(visibleNodesRef.current, camYawRef.current, camPitchRef.current);
          geo3dCamStartRef.current = {
            yaw: camYawRef.current, pitch: camPitchRef.current,
            dist: camDistRef.current, target: { ...camTargetRef.current },
          };
          geo3dCamTargetRef.current = def;
          geo3dTransStartRef.current = performance.now();
          geo3dAnimatingRef.current = true;
        } else {
          transStartRef.current = performance.now();
          viewStartRef.current = { ...viewRef.current };
          viewTargetRef.current = fromMode === 'geo' ? computeGeoFitTransform(visibleNodesRef.current, W, H) : { scale: 1, tx: 0, ty: 0 };
          viewAnimatingRef.current = true;
        }
        return;
      }

      beginCrossModeTransition(fromMode, fromGeo3D, toMode, toGeo3D);
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
      const dt = Math.min((now - lastFrameTimeRef.current) / 1000, 0.05);
      lastFrameTimeRef.current = now;
      const live = useFlowStore.getState();
      const { filterText, scales, selectedNodeId } = live;
      // While a reset-to-neutral phase is playing (see the mode-change
      // effect), pin rendering to the mode/3D-ness it started in — the
      // store's mode/geo3D already flipped to the destination the instant
      // the user clicked, but we don't want to render THAT yet.
      const mode = renderOverrideRef.current?.mode ?? live.mode;
      const geo3D = renderOverrideRef.current?.geo3D ?? live.geo3D;
      const wrap = wrapRef.current!;
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      // While a camera tilt is mid-flight, keep rendering through the 3D
      // path even if `mode` has already flipped to arc underneath it (that
      // happens when 3D was left on and the user switches back to Arc) —
      // otherwise the tilt-down animation would be cut off the instant the
      // mode changes, instead of finishing smoothly.
      const is3D = geo3dAnimatingRef.current || (mode === 'geo' && geo3D);

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
        if (progress >= 1) {
          viewAnimatingRef.current = false;
          // This was a reset-to-neutral phase (2D) — now run the real
          // cross-mode transition it was standing in for.
          if (pendingCrossModeRef.current) {
            const pc = pendingCrossModeRef.current;
            pendingCrossModeRef.current = null;
            beginCrossModeTransition(pc.fromMode, pc.fromGeo3D, pc.toMode, pc.toGeo3D);
          }
        }
      }

      ctx.clearRect(0, 0, W, H);

      const highlight = filterText.trim().toLowerCase();
      const hoverId = hoverNodeRef.current ? hoverNodeRef.current.id : null;
      // Selecting a bulb isolates the edge set to just its own routes, so
      // treat it like a hover for the GL edge/particle shaders too — those
      // routes render at full brightness instead of the default dimmed state.
      const activeId = hoverId ?? selectedNodeId;
      const hoverIdx = activeId !== null ? nodeIdxMapRef.current.get(activeId) ?? -1 : -1;

      ctx.lineCap = 'round';

      let viewProj: Mat4 | null = null;
      if (is3D) {
        if (!camInitializedRef.current) initOrbitCamera(visibleNodesRef.current);
        // Cinematic flight — only while steady in 3D (not mid tilt), so it
        // never fights the camera transition math. Auto Cinema takes over
        // completely when enabled; manual WASD/arrow flight otherwise.
        if (!geo3dAnimatingRef.current) {
          if (live.cinemaMode) applyCinema(dt, now);
          else applyFlight(dt);
        }
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
            if (pendingCrossModeRef.current) {
              // This was a reset-to-neutral phase (3D) — now run the real
              // cross-mode transition it was standing in for.
              const pc = pendingCrossModeRef.current;
              pendingCrossModeRef.current = null;
              beginCrossModeTransition(pc.fromMode, pc.fromGeo3D, pc.toMode, pc.toGeo3D);
            } else if (pendingPositionMorphRef.current) {
              // The tilt-down just finished — now start the flat arc<->geo
              // position morph that was deferred while it played, so the
              // two never fight over the same frame.
              pendingPositionMorphRef.current = false;
              transStartRef.current = now;
              viewStartRef.current = { ...viewRef.current };
              viewTargetRef.current =
                modeRef.current === 'geo'
                  ? computeGeoFitTransform(visibleNodesRef.current, W, H)
                  : { scale: 1, tx: 0, ty: 0 };
              viewAnimatingRef.current = true;
            }
          }
        }
        viewProj = computeViewProjFrom(yaw, pitch, dist, target, W, H, camElevRef.current);
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
        // Selected gets the same bright ring + label as hovered, but persists
        // without the mouse sitting over it. Unlike hover, it does NOT dim
        // its neighbors — the view is already isolated to just this stop's
        // routes, so the other endpoints are exactly what the user asked to
        // see and shouldn't fade away too.
        const isSelected = selectedNodeId === n.id;
        const isHot = hoverId === n.id || isSelected;
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
    let downButton = 0;
    // Anything under this many pixels of movement between mousedown and
    // mouseup still counts as a "click" (selects/deselects a bulb) rather
    // than a pan/orbit drag.
    const CLICK_SLOP = 5;

    function is3DActive() {
      // Match whatever draw() is actually showing right now, not
      // necessarily the store's mode/geo3D — those flip the instant the
      // user clicks a mode button, but rendering (and so controls) may
      // still be mid reset-then-transition (see the mode-change effect).
      if (geo3dAnimatingRef.current) return true;
      const { mode, geo3D } = useFlowStore.getState();
      const rMode = renderOverrideRef.current?.mode ?? mode;
      const rGeo3D = renderOverrideRef.current?.geo3D ?? geo3D;
      return rMode === 'geo' && rGeo3D;
    }

    // Shared by hover and click — same "am I over a bulb" test either way,
    // so clicking to select feels exactly as forgiving/precise as hovering
    // already does.
    function hitTestNode(mx: number, my: number): FlowNode | null {
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
      return found;
    }

    function onHoverMove(mx: number, my: number) {
      const found = hitTestNode(mx, my);
      hoverNodeRef.current = found;
      canvas.style.cursor = found ? 'pointer' : 'grab';
      if (found) {
        onHover({ visible: true, x: mx, y: my, name: found.name, demand: found.demand });
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
        // Signs here are what make the drag feel "grab and rotate" instead
        // of backwards: dragging right should turn the view the same way
        // your hand moved (not spin away from it), and dragging up should
        // tilt the camera down toward eye-level (like Google/Apple Maps'
        // tilt gesture), not toward a MORE top-down view.
        camYawRef.current = orbitStart.yaw - dx * 0.006;
        camPitchRef.current = Math.min(PITCH_MAX, Math.max(PITCH_MIN, orbitStart.pitch + dy * 0.006));
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
      downButton = e.button;
      if (is3DActive()) {
        // Taking the wheel/mouse yourself hands control back from Auto
        // Cinema — it doesn't fight you for the camera.
        if (useFlowStore.getState().cinemaMode) useFlowStore.getState().setCinemaMode(false);
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
          dragStart = { x: e.clientX, y: e.clientY };
          lastPanGround = screenToGround(computeViewProj(wrap.clientWidth, wrap.clientHeight), mx, my, wrap.clientWidth, wrap.clientHeight);
          canvas.style.cursor = 'grabbing';
        }
        return;
      }
      // Grabbing the map mid reset-to-neutral (2D case — the 3D case is
      // handled above via commitCurrentCameraIfAnimating): skip straight to
      // the real transition rather than leaving it stranded pending, then
      // let the drag take over from here.
      if (pendingCrossModeRef.current) {
        const pc = pendingCrossModeRef.current;
        pendingCrossModeRef.current = null;
        beginCrossModeTransition(pc.fromMode, pc.fromGeo3D, pc.toMode, pc.toGeo3D);
        viewAnimatingRef.current = false;
      }
      draggingRef.current = true;
      dragStart = { x: e.clientX, y: e.clientY };
      viewStart = { tx: viewRef.current.tx, ty: viewRef.current.ty };
      canvas.style.cursor = 'grabbing';
    }

    function onUp(e: MouseEvent) {
      const moved = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
      const wasPlainClick = downButton === 0 && moved < CLICK_SLOP;
      draggingRef.current = false;
      orbitDraggingRef.current = false;
      panDraggingRef.current = false;
      lastPanGround = null;

      if (wasPlainClick) {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const found = hitTestNode(mx, my);
        const store = useFlowStore.getState();
        // Click a bulb to isolate just that stop; click it again (or click
        // empty space) to go back to the full view.
        store.setSelectedNode(found && store.selectedNodeId !== found.id ? found.id : null);
      }
      canvas.style.cursor = hoverNodeRef.current ? 'pointer' : 'grab';
    }

    function onContextMenu(e: MouseEvent) {
      if (is3DActive()) e.preventDefault(); // right-click is a drag gesture in 3D, not a menu
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      viewAnimatingRef.current = false;
      if (is3DActive()) {
        if (useFlowStore.getState().cinemaMode) useFlowStore.getState().setCinemaMode(false);
        commitCurrentCameraIfAnimating();
        const factor = Math.exp(e.deltaY * 0.0015);
        camDistRef.current = Math.min(50000, Math.max(50, camDistRef.current * factor));
        return;
      }
      if (pendingCrossModeRef.current) {
        const pc = pendingCrossModeRef.current;
        pendingCrossModeRef.current = null;
        beginCrossModeTransition(pc.fromMode, pc.fromGeo3D, pc.toMode, pc.toGeo3D);
        viewAnimatingRef.current = false;
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
      geo3dAnimatingRef.current = false;
      pendingPositionMorphRef.current = false;
      camElevRef.current = 0;
      flightVelRef.current = { x: 0, z: 0, y: 0 };
      if (useFlowStore.getState().cinemaMode) useFlowStore.getState().setCinemaMode(false);
      // Don't leave a staged cross-mode transition stranded — finish it
      // immediately rather than getting stuck pinned to the old mode.
      if (pendingCrossModeRef.current) {
        const pc = pendingCrossModeRef.current;
        pendingCrossModeRef.current = null;
        renderOverrideRef.current = null;
        modeRef.current = pc.toMode;
        fromModeRef.current = pc.toMode;
      }
      if (is3DActive()) {
        camYawRef.current = 0.6;
        camPitchRef.current = 0.55;
        initOrbitCamera(visibleNodesRef.current);
        return;
      }
      viewRef.current = { scale: 1, tx: 0, ty: 0 };
    }

    const FLIGHT_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'pageup', 'pagedown']);

    function onFlightKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      // Only claim these keys while actually flying in 3D — in 2D, arrows
      // stay free for the top-N shortcuts, and WASD does nothing special.
      if (!is3DActive() || !FLIGHT_KEYS.has(k)) return;
      e.preventDefault();
      // Manual flight input hands control back from Auto Cinema.
      if (useFlowStore.getState().cinemaMode) useFlowStore.getState().setCinemaMode(false);
      flightKeysRef.current.add(k);
    }

    function onFlightKeyUp(e: KeyboardEvent) {
      flightKeysRef.current.delete(e.key.toLowerCase());
    }

    canvas.style.cursor = 'grab';
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onFlightKeyDown);
    window.addEventListener('keyup', onFlightKeyUp);
    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onFlightKeyDown);
      window.removeEventListener('keyup', onFlightKeyUp);
      flightKeysRef.current.clear();
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
        {is3DHint
          ? 'wasd/arrows fly · qe up/down · drag to pan · right-drag to orbit · scroll to zoom · click a bulb to isolate · double-click to reset'
          : 'scroll to zoom · drag to pan · click a bulb to isolate · double-click to reset'}
      </div>
    </div>
  );
}

export const fmt = d3.format(',');