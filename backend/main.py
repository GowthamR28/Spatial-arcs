"""
Spatial Arcs — backend API (Chennai OD flow visualizer).

Run locally:
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000

Endpoints:
    POST   /api/datasets                       upload a CSV, get back dataset_id + summary
    GET    /api/datasets/{id}/summary           stats + detected column mapping warnings
    GET    /api/datasets/{id}/flows             nodes+edges, auto-clustered if too large
    GET    /api/datasets/{id}/nodes/{node_id}/routes   top routes touching one node
    DELETE /api/datasets/{id}                   free memory

See README.md for the clustering strategy and how the frontend consumes this.
"""
import io
import time

import pandas as pd
from fastapi import FastAPI, File, HTTPException, UploadFile, Query
from fastapi.middleware.cors import CORSMiddleware

from data_pipeline import detect_columns, normalize, store

app = FastAPI(title="Spatial Arcs API", version="1.0")

# NOTE: wide open for local dev / demo purposes. Restrict allow_origins to
# your actual frontend origin(s) before deploying this anywhere public.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/datasets")
async def upload_dataset(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(400, "Please upload a .csv file")

    raw = await file.read()
    t0 = time.time()
    try:
        df = pd.read_csv(io.BytesIO(raw))
    except Exception as e:
        raise HTTPException(400, f"Could not parse CSV: {e}")

    try:
        cmap = detect_columns(df)
    except ValueError as e:
        raise HTTPException(422, str(e))

    normalized = normalize(df, cmap)
    if len(normalized) == 0:
        raise HTTPException(422, "No valid rows after parsing lat/lon and trip columns")

    dataset_id = store.add(normalized, file.filename, cmap.warnings)
    meta = store.get_meta(dataset_id)
    elapsed_ms = round((time.time() - t0) * 1000)

    return {
        "dataset_id": dataset_id,
        "rows_ingested": len(normalized),
        "rows_dropped": len(df) - len(normalized),
        "n_edges": meta["n_edges"],
        "n_nodes": meta["n_nodes"],
        "total_trips": meta["total_trips"],
        "column_mapping": {
            "origin_id": cmap.origin_id, "origin_name": cmap.origin_name,
            "origin_lat": cmap.origin_lat, "origin_lon": cmap.origin_lon,
            "dest_id": cmap.dest_id, "dest_name": cmap.dest_name,
            "dest_lat": cmap.dest_lat, "dest_lon": cmap.dest_lon,
            "trips": cmap.trips,
        },
        "warnings": cmap.warnings,
        "parse_time_ms": elapsed_ms,
    }


@app.get("/api/datasets/{dataset_id}/summary")
def dataset_summary(dataset_id: str):
    try:
        meta = store.get_meta(dataset_id)
    except KeyError:
        raise HTTPException(404, "Unknown dataset_id")
    return {
        "dataset_id": dataset_id,
        "source_filename": meta["source_filename"],
        "n_edges": meta["n_edges"],
        "n_nodes": meta["n_nodes"],
        "total_trips": meta["total_trips"],
        "warnings": meta["warnings"],
    }


@app.get("/api/datasets/{dataset_id}/flows")
def dataset_flows(
    dataset_id: str,
    top_n: int = Query(300, ge=1, le=20000, description="Max routes to return"),
    max_nodes: int = Query(400, ge=10, le=5000, description="Cluster nodes above this count"),
):
    try:
        store.get_meta(dataset_id)
    except KeyError:
        raise HTTPException(404, "Unknown dataset_id")

    t0 = time.time()
    result = store.clustered_flows(dataset_id, max_nodes=max_nodes, top_n_edges=top_n)
    result["query_time_ms"] = round((time.time() - t0) * 1000)
    return result


@app.get("/api/datasets/{dataset_id}/nodes/{node_id}/routes")
def node_routes(dataset_id: str, node_id: str, limit: int = 25):
    try:
        store.get_meta(dataset_id)
    except KeyError:
        raise HTTPException(404, "Unknown dataset_id")
    df = store.node_routes(dataset_id, node_id, limit)
    return {"node_id": node_id, "routes": df.to_dict(orient="records")}


@app.delete("/api/datasets/{dataset_id}")
def delete_dataset(dataset_id: str):
    try:
        store.drop(dataset_id)
    except KeyError:
        raise HTTPException(404, "Unknown dataset_id")
    return {"deleted": dataset_id}


@app.get("/api/health")
def health():
    return {"status": "ok", "datasets_loaded": len(store.registry)}
