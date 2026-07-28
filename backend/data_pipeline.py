"""
Data pipeline for Spatial Arcs (Chennai OD flow visualizer).

Responsibilities:
  1. Ingest an arbitrary OD CSV, auto-detecting which columns are
     origin id / origin name / origin lat / origin lon / destination
     equivalents / trip weight -- even when the source file (like the
     user's real export) reuses the same header name twice (e.g. two
     columns both called "origin": one numeric id, one place name).
  2. Store the normalized rows in DuckDB for fast columnar aggregation.
  3. Serve two kinds of read queries cheaply, even at hundreds of
     thousands of rows:
       - top-N routes by trip volume
       - spatially clustered nodes (H3 hexbins) when the raw node count
         would overwhelm the renderer, with edges re-aggregated onto
         the clusters
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Optional

import duckdb
import h3
import pandas as pd

# ---------------------------------------------------------------------------
# Column auto-detection
# ---------------------------------------------------------------------------

_LAT_ORIGIN = ["org_lat", "origin_lat", "o_lat", "from_lat", "start_lat", "src_lat"]
_LON_ORIGIN = ["org_lon", "org_lng", "origin_lon", "o_lon", "from_lon", "start_lon", "src_lon"]
_LAT_DEST = ["dest_lat", "destination_lat", "d_lat", "to_lat", "end_lat"]
_LON_DEST = ["dest_lon", "dest_lng", "destination_lon", "d_lon", "to_lon", "end_lon"]
_TRIPS = ["trips", "value", "count", "weight", "flow", "volume", "demand"]
_ORIGIN_WORDS = ["origin", "from", "source", "org"]
_DEST_WORDS = ["destination", "dest", "to", "target"]


def _norm(h: str) -> str:
    return re.sub(r"[^a-z0-9]", "_", h.strip().lower())


def _find_first(columns: list[str], keywords: list[str], exclude: set[str] = frozenset()) -> Optional[str]:
    for c in columns:
        if c in exclude:
            continue
        n = _norm(c)
        if any(k in n for k in keywords):
            return c
    return None


def _find_all(columns: list[str], keywords: list[str], exclude: set[str]) -> list[str]:
    out = []
    for c in columns:
        if c in exclude:
            continue
        n = _norm(c)
        if any(k in n for k in keywords):
            out.append(c)
    return out


def _is_numeric(df: pd.DataFrame, col: str) -> bool:
    sample = df[col].dropna().head(50)
    if len(sample) == 0:
        return False
    converted = pd.to_numeric(sample, errors="coerce")
    return converted.notna().mean() > 0.8


def _pick_id_and_name(df: pd.DataFrame, candidates: list[str]) -> tuple[Optional[str], Optional[str]]:
    """Given columns that all match e.g. 'origin', decide which is the
    numeric id and which is the human-readable name."""
    if not candidates:
        return None, None
    if len(candidates) == 1:
        return candidates[0], candidates[0]
    numeric = [c for c in candidates if _is_numeric(df, c)]
    textual = [c for c in candidates if c not in numeric]
    id_col = numeric[0] if numeric else candidates[0]
    name_col = textual[0] if textual else candidates[-1]
    return id_col, name_col


@dataclass
class ColumnMap:
    origin_id: str
    origin_name: str
    origin_lat: str
    origin_lon: str
    dest_id: str
    dest_name: str
    dest_lat: str
    dest_lon: str
    trips: str
    warnings: list[str] = field(default_factory=list)


def detect_columns(df: pd.DataFrame) -> ColumnMap:
    columns = list(df.columns)
    warnings: list[str] = []

    org_lat = _find_first(columns, _LAT_ORIGIN)
    org_lon = _find_first(columns, _LON_ORIGIN)
    dst_lat = _find_first(columns, _LAT_DEST)
    dst_lon = _find_first(columns, _LON_DEST)

    used = {c for c in (org_lat, org_lon, dst_lat, dst_lon) if c}

    trips = _find_first(columns, _TRIPS, exclude=used)
    if trips is None:
        # fall back to the first remaining numeric column
        for c in columns:
            if c in used:
                continue
            if _is_numeric(df, c):
                trips = c
                break
    if trips:
        used.add(trips)

    origin_candidates = _find_all(columns, _ORIGIN_WORDS, exclude=used)
    dest_candidates = _find_all(columns, _DEST_WORDS, exclude=used)
    origin_id, origin_name = _pick_id_and_name(df, origin_candidates)
    dest_id, dest_name = _pick_id_and_name(df, dest_candidates)

    missing = [name for name, val in [
        ("origin id", origin_id), ("origin lat", org_lat), ("origin lon", org_lon),
        ("destination id", dest_id), ("destination lat", dst_lat), ("destination lon", dst_lon),
        ("trips", trips),
    ] if val is None]
    if missing:
        raise ValueError(f"Could not auto-detect columns for: {', '.join(missing)}. "
                          f"Available columns: {columns}")

    if origin_name is None:
        origin_name = origin_id
        warnings.append("No separate origin name column found — using origin id as the label.")
    if dest_name is None:
        dest_name = dest_id
        warnings.append("No separate destination name column found — using destination id as the label.")

    return ColumnMap(origin_id, origin_name, org_lat, org_lon,
                      dest_id, dest_name, dst_lat, dst_lon, trips, warnings)


def normalize(df: pd.DataFrame, cmap: ColumnMap) -> pd.DataFrame:
    out = pd.DataFrame({
        "origin_id": df[cmap.origin_id].astype(str),
        "origin_name": df[cmap.origin_name].astype(str),
        "origin_lat": pd.to_numeric(df[cmap.origin_lat], errors="coerce"),
        "origin_lon": pd.to_numeric(df[cmap.origin_lon], errors="coerce"),
        "dest_id": df[cmap.dest_id].astype(str),
        "dest_name": df[cmap.dest_name].astype(str),
        "dest_lat": pd.to_numeric(df[cmap.dest_lat], errors="coerce"),
        "dest_lon": pd.to_numeric(df[cmap.dest_lon], errors="coerce"),
        "trips": pd.to_numeric(df[cmap.trips], errors="coerce").fillna(0),
    })
    out = out.dropna(subset=["origin_lat", "origin_lon", "dest_lat", "dest_lon"])
    return out


# ---------------------------------------------------------------------------
# DuckDB-backed dataset store
# ---------------------------------------------------------------------------

class DatasetStore:
    """One process-wide DuckDB connection; each uploaded dataset gets its
    own table. Fine for a single backend instance — swap for a real
    Postgres/PostGIS + connection pool if you need multi-instance scaling."""

    def __init__(self):
        self.con = duckdb.connect(database=":memory:")
        self.registry: dict[str, dict] = {}

    def add(self, df: pd.DataFrame, source_filename: str, warnings: list[str]) -> str:
        dataset_id = uuid.uuid4().hex[:12]
        table = f"ds_{dataset_id}"
        self.con.register("tmp_df", df)
        self.con.execute(f"CREATE TABLE {table} AS SELECT * FROM tmp_df")
        self.con.unregister("tmp_df")

        summary = self.con.execute(f"""
            SELECT
              COUNT(*) AS n_edges,
              SUM(trips) AS total_trips,
              COUNT(DISTINCT origin_id) + COUNT(DISTINCT dest_id) AS approx_nodes
            FROM {table}
        """).fetchdf().iloc[0].to_dict()

        n_nodes = self.con.execute(f"""
            SELECT COUNT(*) FROM (
              SELECT origin_id AS id FROM {table}
              UNION
              SELECT dest_id AS id FROM {table}
            )
        """).fetchone()[0]

        self.registry[dataset_id] = {
            "table": table,
            "source_filename": source_filename,
            "warnings": warnings,
            "n_edges": int(summary["n_edges"]),
            "total_trips": float(summary["total_trips"] or 0),
            "n_nodes": int(n_nodes),
        }
        return dataset_id

    def get_meta(self, dataset_id: str) -> dict:
        if dataset_id not in self.registry:
            raise KeyError(dataset_id)
        return self.registry[dataset_id]

    def drop(self, dataset_id: str):
        meta = self.get_meta(dataset_id)
        self.con.execute(f"DROP TABLE IF EXISTS {meta['table']}")
        del self.registry[dataset_id]

    # -- flow queries --------------------------------------------------

    def top_routes(self, dataset_id: str, top_n: int) -> pd.DataFrame:
        table = self.get_meta(dataset_id)["table"]
        return self.con.execute(f"""
            SELECT origin_id, origin_name, origin_lat, origin_lon,
                   dest_id, dest_name, dest_lat, dest_lon, trips
            FROM {table}
            ORDER BY trips DESC
            LIMIT {int(top_n)}
        """).fetchdf()

    def node_routes(self, dataset_id: str, node_id: str, limit: int = 25) -> pd.DataFrame:
        table = self.get_meta(dataset_id)["table"]
        return self.con.execute(f"""
            SELECT * FROM {table}
            WHERE origin_id = ? OR dest_id = ?
            ORDER BY trips DESC LIMIT {int(limit)}
        """, [node_id, node_id]).fetchdf()

    def clustered_flows(self, dataset_id: str, max_nodes: int, top_n_edges: int) -> dict:
        """Adaptive H3 clustering: pick the coarsest resolution that still
        keeps the number of distinct hex cells <= max_nodes, aggregate
        node demand into cells, and re-aggregate edges onto cell pairs.
        This is what keeps 50k+ raw rows rendering smoothly."""
        table = self.get_meta(dataset_id)["table"]
        df = self.con.execute(f"""
            SELECT origin_id, origin_name, origin_lat, origin_lon,
                   dest_id, dest_name, dest_lat, dest_lon, trips
            FROM {table}
        """).fetchdf()

        # Build the unique node set once (id -> lat/lon/name/demand)
        o = df[["origin_id", "origin_name", "origin_lat", "origin_lon", "trips"]].rename(
            columns={"origin_id": "id", "origin_name": "name", "origin_lat": "lat", "origin_lon": "lon"})
        d = df[["dest_id", "dest_name", "dest_lat", "dest_lon", "trips"]].rename(
            columns={"dest_id": "id", "dest_name": "name", "dest_lat": "lat", "dest_lon": "lon"})
        nodes = pd.concat([o, d], ignore_index=True)
        node_demand = nodes.groupby("id").agg(
            name=("name", "first"), lat=("lat", "first"), lon=("lon", "first"),
            demand=("trips", "sum")).reset_index()

        if len(node_demand) <= max_nodes:
            edges = self.top_routes(dataset_id, top_n_edges)
            return {
                "clustered": False,
                "resolution": None,
                "nodes": node_demand.to_dict(orient="records"),
                "edges": edges.rename(columns={
                    "origin_id": "source", "dest_id": "target", "trips": "value"
                }).to_dict(orient="records"),
            }

        # binary search the coarsest H3 resolution with cell count <= max_nodes
        resolution = 3
        cells = None
        for res in range(9, 0, -1):
            test_cells = node_demand.apply(
                lambda r: h3.latlng_to_cell(r["lat"], r["lon"], res), axis=1)
            if test_cells.nunique() <= max_nodes:
                resolution = res
                cells = test_cells
                break
        if cells is None:
            resolution = 1
            cells = node_demand.apply(lambda r: h3.latlng_to_cell(r["lat"], r["lon"], 1), axis=1)

        node_demand = node_demand.assign(cell=cells)
        id_to_cell = dict(zip(node_demand["id"], node_demand["cell"]))

        cluster_nodes = node_demand.groupby("cell").agg(
            demand=("demand", "sum"), members=("id", "count")).reset_index()
        cluster_nodes["lat"] = cluster_nodes["cell"].apply(lambda c: h3.cell_to_latlng(c)[0])
        cluster_nodes["lon"] = cluster_nodes["cell"].apply(lambda c: h3.cell_to_latlng(c)[1])
        cluster_nodes["name"] = cluster_nodes.apply(
            lambda r: f"Cluster of {r['members']} stops" if r["members"] > 1 else
            node_demand.loc[node_demand["cell"] == r["cell"], "name"].iloc[0], axis=1)
        cluster_nodes = cluster_nodes.rename(columns={"cell": "id"})

        df = df.assign(
            source_cell=df["origin_id"].map(id_to_cell),
            target_cell=df["dest_id"].map(id_to_cell),
        )
        edge_agg = df.groupby(["source_cell", "target_cell"]).agg(
            value=("trips", "sum")).reset_index()
        edge_agg = edge_agg[edge_agg["source_cell"] != edge_agg["target_cell"]]
        edge_agg = edge_agg.sort_values("value", ascending=False).head(top_n_edges)
        edge_agg = edge_agg.rename(columns={"source_cell": "source", "target_cell": "target"})

        return {
            "clustered": True,
            "resolution": resolution,
            "nodes": cluster_nodes[["id", "name", "lat", "lon", "demand"]].to_dict(orient="records"),
            "edges": edge_agg.to_dict(orient="records"),
        }


store = DatasetStore()
