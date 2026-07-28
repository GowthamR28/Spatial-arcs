export interface RawRow {
  origin: string;
  destination: string;
  originName: string;
  destinationName: string;
  trips: number;
  org_lat: number;
  org_lon: number;
  dest_lat: number;
  dest_lon: number;
}

export interface LabelPlacement {
  show: boolean;
  text: string;
  dx: number;
  dy: number;
  angle: number; // radians, for diagonal labels in dense regions
  align: CanvasTextAlign;
  // Order in which this label "won" a spot in the greedy placement pass —
  // 0 is the busiest/most important stop that got placed. Used to show
  // fewer labels when zoomed out (where bubbles sit closer together and
  // labels start overlapping neighbors) and more as you zoom in.
  rank: number;
}

export interface FlowNode {
  id: string;
  name: string;
  lat: number;
  lon: number;
  demand: number;
  arc: { x: number; y: number };
  geo: { x: number; y: number };
  // Precomputed once per layout (not per animation frame) so 50k-edge
  // datasets don't pay for collision detection 60x/sec.
  arcLabel?: LabelPlacement;
  geoLabel?: LabelPlacement;
}

export interface FlowEdgeRaw {
  sourceId: string;
  targetId: string;
  value: number;
}

export interface FlowEdge extends FlowEdgeRaw {
  s: FlowNode;
  t: FlowNode;
}

export interface Particle {
  edgeIndex: number;
  t: number;
  speed: number;
}

export type ViewMode = 'arc' | 'geo';

export interface FlowMeta {
  clustered?: boolean;
  resolution?: number;
  query_time_ms?: number;
}