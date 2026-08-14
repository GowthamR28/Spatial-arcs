import { create } from 'zustand';
import type { FlowNode, FlowEdgeRaw, ViewMode, RawRow, FlowMeta } from '../lib/types';
import { computeLayouts, type Scales } from '../lib/layout';
import { SAMPLE_ROWS } from '../data/sample';
import type { WorkerResponse } from '../lib/csv.worker';
import { DEFAULT_PALETTE_ID, getPalette } from '../lib/palettes';
import type { ClassificationMethod } from '../lib/classification';

export type ApiStatus = 'local' | 'connecting' | 'connected' | 'error' | 'uploading' | 'upload-failed';

// However many OD pairs a file has, only render this many routes by default.
// This is the single biggest lever for perceived performance: the old code
// set topN = edges.length on every import, so a 50k-row file meant 50k arcs
// + up to 100k particles animating on the very first frame. The slider still
// goes all the way up to the full dataset if the user wants it.
export const DEFAULT_TOPN_CAP = 500;

interface FlowState {
  nodes: Map<string, FlowNode>;
  edgesRaw: FlowEdgeRaw[];
  scales: Scales;
  mode: ViewMode;
  topN: number;
  maxTopN: number;
  filterText: string;
  apiBase: string | null;
  apiStatus: ApiStatus;
  datasetId: string | null;
  backendMode: boolean;
  geo3D: boolean;
  maxNodesServer: number;
  meta: FlowMeta | null;
  canvasSize: { w: number; h: number };
  loading: boolean;
  loadError: string | null;
  paletteId: string;
  classification: ClassificationMethod;

  ingest: (rows: RawRow[]) => void;
  ingestAggregated: (nodesArr: any[], edgesArr: any[], meta: FlowMeta) => void;
  ingestFromFile: (file: File) => void;
  setCanvasSize: (w: number, h: number) => void;
  setMode: (m: ViewMode) => void;
  setTopN: (n: number) => void;
  setFilterText: (t: string) => void;
  setApiBase: (url: string | null) => void;
  setApiStatus: (s: ApiStatus) => void;
  setDatasetId: (id: string | null) => void;
  setBackendMode: (b: boolean) => void;
  setGeo3D: (b: boolean) => void;
  setPalette: (id: string) => void;
  setClassification: (m: ClassificationMethod) => void;
  recomputeLayouts: () => void;
}

function buildFromRows(rows: RawRow[]) {
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdgeRaw[] = [];
  rows.forEach((r) => {
    const oId = String(r.origin);
    const dId = String(r.destination);
    if (!nodes.has(oId))
      nodes.set(oId, { id: oId, name: r.originName || oId, lat: +r.org_lat, lon: +r.org_lon, demand: 0, arc: { x: 0, y: 0 }, geo: { x: 0, y: 0 } });
    if (!nodes.has(dId))
      nodes.set(dId, { id: dId, name: r.destinationName || dId, lat: +r.dest_lat, lon: +r.dest_lon, demand: 0, arc: { x: 0, y: 0 }, geo: { x: 0, y: 0 } });
    const v = +r.trips || 0;
    nodes.get(oId)!.demand += v;
    nodes.get(dId)!.demand += v;
    edges.push({ sourceId: oId, targetId: dId, value: v });
  });
  edges.sort((a, b) => b.value - a.value);
  return { nodes, edges };
}

export const useFlowStore = create<FlowState>((set, get) => ({
  nodes: new Map(),
  edgesRaw: [],
  scales: computeLayouts(new Map(), [], 1000, 700, getPalette(DEFAULT_PALETTE_ID).colors, 'quantile'),
  mode: 'arc',
  topN: SAMPLE_ROWS.length,
  maxTopN: SAMPLE_ROWS.length,
  filterText: '',
  apiBase: null,
  apiStatus: 'local',
  datasetId: null,
  backendMode: false,
  geo3D: false,
  maxNodesServer: 400,
  meta: null,
  canvasSize: { w: 1000, h: 700 },
  loading: false,
  loadError: null,
  paletteId: DEFAULT_PALETTE_ID,
  classification: 'quantile',

  ingest: (rows) => {
    const { nodes, edges } = buildFromRows(rows);
    const { w, h } = get().canvasSize;
    const scales = computeLayouts(nodes, edges, w, h, getPalette(get().paletteId).colors, get().classification);
    set({
      nodes, edgesRaw: edges, scales, meta: null,
      topN: Math.min(DEFAULT_TOPN_CAP, edges.length),
      maxTopN: edges.length,
    });
  },

  ingestAggregated: (nodesArr, edgesArr, meta) => {
    const nodes = new Map<string, FlowNode>();
    nodesArr.forEach((n) =>
      nodes.set(String(n.id), {
        id: String(n.id), name: n.name, lat: +n.lat, lon: +n.lon, demand: +n.demand,
        arc: { x: 0, y: 0 }, geo: { x: 0, y: 0 },
      })
    );
    const edges: FlowEdgeRaw[] = edgesArr
      .map((e) => ({ sourceId: String(e.source), targetId: String(e.target), value: +e.value }))
      .sort((a, b) => b.value - a.value);
    const { w, h } = get().canvasSize;
    const scales = computeLayouts(nodes, edges, w, h, getPalette(get().paletteId).colors, get().classification);
    // The backend already applies top_n / H3 clustering server-side, so
    // whatever it hands back is meant to be shown as-is.
    set({ nodes, edgesRaw: edges, scales, meta, topN: edges.length, maxTopN: Math.max(edges.length, get().maxTopN) });
  },

  ingestFromFile: (file) => {
    set({ loading: true, loadError: null });
    const worker = new Worker(new URL('../lib/csv.worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'error') {
        set({ loading: false, loadError: msg.message });
        worker.terminate();
        return;
      }
      if (msg.edges.length === 0) {
        set({ loading: false, loadError: 'Could not detect origin/destination/lat/lon columns automatically.' });
        worker.terminate();
        return;
      }
      const nodes = new Map<string, FlowNode>();
      msg.nodes.forEach((n) => nodes.set(n.id, n));
      const { w, h } = get().canvasSize;
      const scales = computeLayouts(nodes, msg.edges, w, h, getPalette(get().paletteId).colors, get().classification);
      set({
        nodes, edgesRaw: msg.edges, scales, meta: null,
        topN: Math.min(DEFAULT_TOPN_CAP, msg.edges.length),
        maxTopN: msg.edges.length,
        loading: false, loadError: null,
      });
      worker.terminate();
    };

    worker.onerror = (err) => {
      set({ loading: false, loadError: err.message || 'Failed to parse CSV.' });
      worker.terminate();
    };

    const reader = new FileReader();
    reader.onload = () => worker.postMessage({ text: reader.result as string });
    reader.onerror = () => {
      set({ loading: false, loadError: 'Could not read file.' });
      worker.terminate();
    };
    reader.readAsText(file);
  },

  setCanvasSize: (w, h) => {
    set({ canvasSize: { w, h } });
    get().recomputeLayouts();
  },

  recomputeLayouts: () => {
    const { nodes, edgesRaw, canvasSize, paletteId, classification } = get();
    const scales = computeLayouts(nodes, edgesRaw, canvasSize.w, canvasSize.h, getPalette(paletteId).colors, classification);
    set({ scales });
  },

  setMode: (m) => set({ mode: m }),
  setTopN: (n) => set({ topN: n }),
  setFilterText: (t) => set({ filterText: t }),
  setApiBase: (url) => set({ apiBase: url }),
  setApiStatus: (s) => set({ apiStatus: s }),
  setDatasetId: (id) => set({ datasetId: id }),
  setBackendMode: (b) => set({ backendMode: b }),
  setGeo3D: (b) => set({ geo3D: b }),
  setPalette: (id) => {
    set({ paletteId: id });
    get().recomputeLayouts();
  },
  setClassification: (m) => {
    set({ classification: m });
    get().recomputeLayouts();
  },
}));

export function initSample() {
  useFlowStore.getState().ingest(SAMPLE_ROWS);
}