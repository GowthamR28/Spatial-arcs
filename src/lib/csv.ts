import type { RawRow, FlowNode, FlowEdgeRaw } from './types';

interface HeaderInfo {
  raw: string;
  key: string;
  occurrence: number;
}

function parseCSV(text: string): { headers: HeaderInfo[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  const headerCells = lines[0].split(',').map((h) => h.trim());
  const seen: Record<string, number> = {};
  const headers = headerCells.map((h) => {
    const key = h.toLowerCase();
    seen[key] = (seen[key] || 0) + 1;
    return { raw: h, key, occurrence: seen[key] };
  });
  const rows = lines.slice(1).map((l) => l.split(',').map((c) => c.trim()));
  return { headers, rows };
}

function isNumericCol(_headers: HeaderInfo[], rows: string[][], idx: number): boolean {
  let numeric = 0;
  let total = 0;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const v = rows[i][idx];
    if (v === undefined || v === '') continue;
    total++;
    if (!isNaN(parseFloat(v))) numeric++;
  }
  return total > 0 && numeric / total > 0.8;
}

function detectColumns(headers: HeaderInfo[], rows: string[][]) {
  const find = (patterns: string[]) => headers.findIndex((h) => patterns.some((p) => h.key.includes(p)));
  const findAll = (patterns: string[]) =>
    headers.map((h, i) => ({ h, i })).filter(({ h }) => patterns.some((p) => h.key.includes(p)));

  const orgLat = find(['org_lat', 'origin_lat', 'o_lat', 'from_lat', 'start_lat', 'src_lat']);
  const orgLon = find(['org_lon', 'origin_lon', 'org_lng', 'o_lon', 'from_lon', 'start_lon', 'src_lon']);
  const dstLat = find(['dest_lat', 'destination_lat', 'd_lat', 'to_lat', 'end_lat']);
  const dstLon = find(['dest_lon', 'destination_lon', 'dest_lng', 'd_lon', 'to_lon', 'end_lon']);

  let tripsIdx = find(['trips', 'value', 'count', 'weight', 'flow', 'volume']);
  if (tripsIdx < 0) {
    for (let i = 0; i < headers.length; i++) {
      if ([orgLat, orgLon, dstLat, dstLon].includes(i)) continue;
      if (isNumericCol(headers, rows, i)) {
        tripsIdx = i;
        break;
      }
    }
  }

  const originCols = findAll(['origin', 'from', 'source', 'org']).filter(({ i }) => ![orgLat, orgLon].includes(i));
  const destCols = findAll(['destination', 'dest', 'to', 'target']).filter(({ i }) => ![dstLat, dstLon].includes(i));

  const pickIdName = (cols: { h: HeaderInfo; i: number }[]) => {
    if (cols.length === 0) return { idIdx: -1, nameIdx: -1 };
    if (cols.length === 1) return { idIdx: cols[0].i, nameIdx: cols[0].i };
    const numeric = cols.filter((c) => isNumericCol(headers, rows, c.i));
    const text = cols.filter((c) => !isNumericCol(headers, rows, c.i));
    return {
      idIdx: (numeric[0] || cols[0]).i,
      nameIdx: (text[0] || cols[cols.length - 1]).i,
    };
  };
  const org = pickIdName(originCols);
  const dst = pickIdName(destCols);

  return {
    orgLat, orgLon, dstLat, dstLon, tripsIdx,
    orgId: org.idIdx, orgName: org.nameIdx,
    dstId: dst.idIdx, dstName: dst.nameIdx,
  };
}

export function rowsFromCSV(text: string): RawRow[] {
  const { headers, rows } = parseCSV(text);
  const c = detectColumns(headers, rows);
  return rows
    .filter((r) => r.length >= headers.length - 1)
    .map((r) => ({
      origin: r[c.orgId],
      destination: r[c.dstId],
      originName: c.orgName >= 0 ? r[c.orgName] : r[c.orgId],
      destinationName: c.dstName >= 0 ? r[c.dstName] : r[c.dstId],
      trips: parseFloat(r[c.tripsIdx]) || 0,
      org_lat: parseFloat(r[c.orgLat]),
      org_lon: parseFloat(r[c.orgLon]),
      dest_lat: parseFloat(r[c.dstLat]),
      dest_lon: parseFloat(r[c.dstLon]),
    }))
    .filter((r) => r.origin && r.destination && !isNaN(r.org_lat) && !isNaN(r.dest_lat));
}

/**
 * Parses + aggregates a CSV in a single pass, without ever materializing the
 * intermediate RawRow[] array. This matters at scale: for 50k+ rows, building
 * one array of typed rows and then a second pass to build node/edge maps
 * roughly doubles allocations and GC pressure versus folding straight into
 * the aggregation below. This is what the parsing Web Worker calls, so none
 * of it runs on the UI thread.
 */
export function aggregateCSV(text: string): { nodes: FlowNode[]; edges: FlowEdgeRaw[] } {
  const { headers, rows } = parseCSV(text);
  const c = detectColumns(headers, rows);
  if (c.orgId < 0 || c.dstId < 0 || c.orgLat < 0 || c.dstLat < 0) {
    return { nodes: [], edges: [] };
  }

  const nodes = new Map<string, FlowNode>();
  // Aggregate parallel OD pairs (same origin+destination appearing on
  // multiple rows) into a single edge instead of one edge per row. This is
  // usually what makes a "50k row" file collapse down to a much smaller,
  // renderable edge count, since real OD data is rarely all-unique pairs.
  const edgeIndex = new Map<string, FlowEdgeRaw>();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < headers.length - 1) continue;
    const oId = r[c.orgId];
    const dId = r[c.dstId];
    if (!oId || !dId) continue;
    const orgLat = parseFloat(r[c.orgLat]);
    const orgLon = parseFloat(r[c.orgLon]);
    const dstLat = parseFloat(r[c.dstLat]);
    const dstLon = parseFloat(r[c.dstLon]);
    if (isNaN(orgLat) || isNaN(dstLat)) continue;
    const v = parseFloat(r[c.tripsIdx]) || 0;

    let oNode = nodes.get(oId);
    if (!oNode) {
      oNode = {
        id: oId,
        name: (c.orgName >= 0 ? r[c.orgName] : oId) || oId,
        lat: orgLat, lon: orgLon, demand: 0,
        arc: { x: 0, y: 0 }, geo: { x: 0, y: 0 },
      };
      nodes.set(oId, oNode);
    }
    let dNode = nodes.get(dId);
    if (!dNode) {
      dNode = {
        id: dId,
        name: (c.dstName >= 0 ? r[c.dstName] : dId) || dId,
        lat: dstLat, lon: dstLon, demand: 0,
        arc: { x: 0, y: 0 }, geo: { x: 0, y: 0 },
      };
      nodes.set(dId, dNode);
    }
    oNode.demand += v;
    dNode.demand += v;

    const key = oId + '\u0000' + dId;
    const existing = edgeIndex.get(key);
    if (existing) {
      existing.value += v;
    } else {
      edgeIndex.set(key, { sourceId: oId, targetId: dId, value: v });
    }
  }

  const edges = Array.from(edgeIndex.values()).sort((a, b) => b.value - a.value);
  return { nodes: Array.from(nodes.values()), edges };
}
