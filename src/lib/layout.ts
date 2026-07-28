import * as d3 from 'd3';
import type { FlowNode, FlowEdgeRaw, LabelPlacement, ViewMode } from './types';
import { orientLightToDark } from './palettes';
import { buildClassifiedScale, type ClassificationMethod } from './classification';

// Bottom margin is deliberately generous — it's what gives diagonal labels
// room to run without clipping, and pushes the whole baseline (and therefore
// the arcs above it) up within the canvas.
export const MARGIN = { top: 50, right: 60, bottom: 150, left: 60 };

export interface Scales {
  radiusScale: d3.ScalePower<number, number>;
  nodeColorScale: (v: number) => string;
  colorScale: (v: number) => string;
  widthScale: d3.ScalePower<number, number>;
}

export function computeLayouts(
  nodes: Map<string, FlowNode>,
  edges: FlowEdgeRaw[],
  W: number,
  H: number,
  paletteColors: string[],
  classification: ClassificationMethod = 'quantile'
): Scales {
  const ramp = orientLightToDark(paletteColors);
  const nodesArr = Array.from(nodes.values());
  if (nodesArr.length === 0) {
    return {
      radiusScale: d3.scaleSqrt().domain([0, 1]).range([3.5, 23]),
      nodeColorScale: () => ramp[0],
      colorScale: () => ramp[0],
      widthScale: d3.scaleSqrt().domain([0, 1]).range([0.9, 5]),
    };
  }

  // GEO layout — mercator fit to extent
  const fc = {
    type: 'FeatureCollection' as const,
    features: nodesArr.map((n) => ({
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'Point' as const, coordinates: [n.lon, n.lat] as [number, number] },
    })),
  };
  const proj = d3
    .geoMercator()
    .fitExtent([[MARGIN.left, MARGIN.top], [W - MARGIN.right, H - MARGIN.bottom]], fc);
  nodesArr.forEach((n) => {
    const p = proj([n.lon, n.lat]);
    if (p) n.geo = { x: p[0], y: p[1] };
  });

  // ARC layout — sorted by geography, laid along baseline
  const sorted = [...nodesArr].sort((a, b) => a.lat - b.lat || a.lon - b.lon);
  const baselineY = H - MARGIN.bottom;
  const usableW = W - MARGIN.left - MARGIN.right;
  sorted.forEach((n, i) => {
    n.arc = {
      x: MARGIN.left + (sorted.length <= 1 ? usableW / 2 : (i / (sorted.length - 1)) * usableW),
      y: baselineY,
    };
  });

  const demandExtent = d3.extent(nodesArr, (n) => n.demand) as [number, number];
  const radiusScale = d3
    .scaleSqrt()
    .domain(demandExtent[0] === demandExtent[1] ? [0, demandExtent[1] || 1] : demandExtent)
    .range([3.5, 23]);
  // Classification method is user-selectable (Settings): Quantile, Equal
  // Interval, Natural Breaks (Jenks), or Logarithmic. Whichever is active,
  // trip-count/demand data is usually right-skewed, so the default
  // (Quantile) buckets by rank rather than raw value — guaranteeing every
  // step of the palette gets used regardless of skew — but the others are
  // there for when a different story fits the data better.
  const nodeColorScale = buildClassifiedScale(nodesArr.map((n) => n.demand), ramp, classification);

  const valueExtent = d3.extent(edges, (e) => e.value) as [number, number];
  const colorScale = buildClassifiedScale(edges.map((e) => e.value), ramp, classification);
  const widthScale = d3
    .scaleSqrt()
    .domain(valueExtent[0] === valueExtent[1] ? [0, valueExtent[1] || 1] : valueExtent)
    .range([0.9, 5]);

  // Precompute which nodes get a label, and where — once, here, rather than
  // in the render loop. With hundreds/thousands of stops packed into one
  // baseline strip (arc mode) this is the difference between a legible chart
  // and a wall of overlapping text at 60fps.
  computeLabelPlacement(nodesArr, 'arc', radiusScale);
  computeLabelPlacement(nodesArr, 'geo', radiusScale);

  return { radiusScale, nodeColorScale, colorScale, widthScale };
}

// Cap the number of labels drawn regardless of dataset size — the busiest
// stops earn a label, the rest just show as dots (still hoverable/searchable).
export const MAX_LABELS = 160;

interface Rect { x0: number; y0: number; x1: number; y1: number; }

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

// Rough (but cheap) axis-aligned bounding box for a run of text anchored at
// (x, y), optionally rotated by `angle` radians. Good enough for a collision
// heuristic — doesn't need to be pixel-exact.
function textBBox(x: number, y: number, w: number, h: number, align: CanvasTextAlign, angle: number): Rect {
  const ax = align === 'center' ? -w / 2 : align === 'right' ? -w : 0;
  const corners = [
    { x: ax, y: -h * 0.75 },
    { x: ax + w, y: -h * 0.75 },
    { x: ax + w, y: h * 0.35 },
    { x: ax, y: h * 0.35 },
  ].map((p) => ({
    x: x + p.x * Math.cos(angle) - p.y * Math.sin(angle),
    y: y + p.x * Math.sin(angle) + p.y * Math.cos(angle),
  }));
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx;
  if (typeof document === 'undefined') {
    measureCtx = null; // running inside a worker with no DOM — estimate width instead
    return measureCtx;
  }
  const c = document.createElement('canvas');
  measureCtx = c.getContext('2d');
  if (measureCtx) measureCtx.font = "500 10px 'Inter', sans-serif";
  return measureCtx;
}

function measureWidth(text: string): number {
  const ctx = getMeasureCtx();
  return ctx ? ctx.measureText(text).width : text.length * 5.8;
}

/**
 * Greedy, rank-by-demand label placement with a diagonal fallback. The
 * busiest nodes get first pick of a flat label; if that collides with an
 * already-placed label, we try a rotated diagonal placement (which eats far
 * less horizontal space in a dense baseline strip); if that still collides,
 * the node simply doesn't get a static label — it can still be labeled
 * dynamically on hover/search in FlowCanvas.
 */
export function computeLabelPlacement(nodesArr: FlowNode[], mode: ViewMode, radiusScale: d3.ScalePower<number, number>) {
  const ordered = [...nodesArr].sort((a, b) => b.demand - a.demand);
  const placed: Rect[] = [];
  let shown = 0;

  ordered.forEach((n) => {
    const pos = mode === 'arc' ? n.arc : n.geo;
    const r = radiusScale(n.demand);
    const text = n.name.length > 22 ? n.name.slice(0, 20) + '…' : n.name;
    const w = measureWidth(text);
    const h = 12;

    let placement: LabelPlacement | null = null;
    if (shown < MAX_LABELS) {
      // Arc mode: always diagonal, one consistent angle, running down-right
      // from each stop — this is what makes a dense baseline of labels read
      // as an even "staircase" instead of a mix of flat and angled text.
      // Geo mode: flat to the right is fine there since nodes aren't forced
      // onto a single line, with a diagonal fallback for tight clusters.
      const candidates: Omit<LabelPlacement, 'rank'>[] =
        mode === 'arc'
          ? [{ show: true, text, dx: r * 0.55 + 4, dy: r * 0.55 + 8, angle: Math.PI / 4, align: 'left' }]
          : [
              { show: true, text, dx: r + 6, dy: 0, angle: 0, align: 'left' },
              { show: true, text, dx: r + 4, dy: r + 4, angle: -Math.PI / 6, align: 'left' },
            ];

      for (const cand of candidates) {
        const box = textBBox(pos.x + cand.dx, pos.y + cand.dy, w, h, cand.align, cand.angle);
        if (!placed.some((p) => rectsOverlap(p, box))) {
          placed.push(box);
          placement = { ...cand, rank: shown };
          shown++;
          break;
        }
      }
    }

    if (mode === 'arc') n.arcLabel = placement ?? { show: false, text, dx: 0, dy: 0, angle: 0, align: 'center', rank: Infinity };
    else n.geoLabel = placement ?? { show: false, text, dx: 0, dy: 0, angle: 0, align: 'left', rank: Infinity };
  });
}

export function ease(t: number): number {
  // Plain, monotonic easeInOutCubic — no overshoot. An earlier version used
  // easeInOutBack for a springier feel, but combined with the view-transform
  // jump (see FlowCanvas mode-switch handling) it read as an unwanted swing
  // rather than a satisfying bounce. Smooth and predictable wins here.
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function nodePos(n: FlowNode, t: number): { x: number; y: number } {
  return { x: lerp(n.arc.x, n.geo.x, t), y: lerp(n.arc.y, n.geo.y, t) };
}

export function controlPoint(p0: { x: number; y: number }, p1: { x: number; y: number }, t: number) {
  const midx = (p0.x + p1.x) / 2;
  const midy = (p0.y + p1.y) / 2;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dist = Math.max(Math.hypot(dx, dy), 1);
  // Arc height is distance-based (standard arc-diagram convention) — trip
  // volume is fully encoded by color/width already. Tying height to value
  // too caused a single high-traffic-but-nearby pair to spike into a
  // disproportionate needle while everything else stayed flat.
  const arcCtrl = { x: midx, y: midy - dist * 0.55 };
  const nx = -dy / dist;
  const ny = dx / dist;
  const geoCtrl = { x: midx + nx * dist * 0.16, y: midy + ny * dist * 0.16 };
  return { x: lerp(arcCtrl.x, geoCtrl.x, t), y: lerp(arcCtrl.y, geoCtrl.y, t) };
}

export function quadPoint(
  p0: { x: number; y: number },
  c: { x: number; y: number },
  p1: { x: number; y: number },
  t: number
) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
  };
}

/**
 * Mercator's fitExtent preserves aspect ratio, so if the data's lat/lon
 * bounding box doesn't match the canvas's aspect ratio, one axis ends up
 * "letterboxed" — nodes only fill a fraction of the canvas with big empty
 * margins on the other axis. This computes a pan/zoom transform that fits
 * the *actual* node bounding box snugly into the canvas, so entering Geo
 * mode reads as a proper zoomed-in map instead of a small cluster adrift in
 * whitespace.
 */
export function computeGeoFitTransform(
  nodesArr: FlowNode[],
  W: number,
  H: number
): { scale: number; tx: number; ty: number } {
  if (nodesArr.length === 0) return { scale: 1, tx: 0, ty: 0 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  nodesArr.forEach((n) => {
    minX = Math.min(minX, n.geo.x);
    maxX = Math.max(maxX, n.geo.x);
    minY = Math.min(minY, n.geo.y);
    maxY = Math.max(maxY, n.geo.y);
  });
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  const padding = 0.85; // leave a little breathing room, don't fit edge-to-edge
  const scale = Math.min((W / bw) * padding, (H / bh) * padding, 6);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    scale,
    tx: W / 2 - cx * scale,
    ty: H / 2 - cy * scale,
  };
}