# Spatial Arcs — Backend

FastAPI + DuckDB + H3, built to do the heavy lifting the browser shouldn't:
ingest a large OD CSV, auto-detect its columns (including files that reuse
a header name twice, like `origin` for both an id and a place name), and
serve either the raw top-N routes or an **adaptively clustered** view when
the node count would overwhelm the renderer.

Tested end-to-end against a synthetic 50,000-row Chennai-shaped dataset:

| Operation | Time |
|---|---|
| Upload + parse + column auto-detect + DuckDB load (50k rows) | ~300ms |
| `/flows` query, capped at 150 nodes → auto-clustered to H3 res 6 (38 clusters) | ~100ms |
| `/flows` query, uncapped (800 raw nodes, top 500 edges) | ~60ms |

## Run it

```bash
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Or with Docker:

```bash
docker build -t od-flow-api .
docker run -p 8000:8000 od-flow-api
```

Check it's alive: `curl http://localhost:8000/api/health`

## Connect the frontend

Open `spatial-arcs.html`, paste your backend URL (e.g.
`http://localhost:8000`) into the "Backend URL" field in the toolbar and
hit **Connect**. Once it says "connected", **Upload CSV** sends the file
to the backend instead of parsing it in-browser — this is what lets you
load the real 50k-row file without the browser choking, and lets the
"Top N routes" slider re-query the server instead of re-slicing a giant
array on the main thread.

If you don't connect a backend, the page still works standalone — CSV
parsing and top-N slicing happen client-side, which is fine for smaller
files or quick demos, just won't scale past a few thousand rows smoothly.

## How the clustering decision is made

`GET /api/datasets/{id}/flows?top_n=300&max_nodes=400`

1. Build the full node set (every distinct origin_id + dest_id) with
   summed demand.
2. If the node count is already under `max_nodes`, return it as-is —
   just the top-N edges by trip volume.
3. Otherwise, binary-search H3 resolutions from 9 down to 1 to find the
   **coarsest** resolution whose hex-cell count still fits under
   `max_nodes`. Node demand and edge trip counts get re-aggregated onto
   those cells. Self-loops (a cell flowing to itself) are dropped.
4. The response tells you which path was taken (`clustered: true/false`,
   `resolution`) so the frontend can show that honestly instead of
   silently swapping data granularity on you.

This is a single-process, in-memory DuckDB instance — good for a demo or
a single-team internal tool. For real production multi-user scale, swap
`DatasetStore` for Postgres/PostGIS with connection pooling, and put
uploaded CSVs in object storage instead of holding them in RAM.

## Endpoints

- `POST /api/datasets` — multipart file upload, returns `dataset_id` +
  detected column mapping + summary stats
- `GET /api/datasets/{id}/summary`
- `GET /api/datasets/{id}/flows?top_n=&max_nodes=`
- `GET /api/datasets/{id}/nodes/{node_id}/routes?limit=`
- `DELETE /api/datasets/{id}`

## Before deploying anywhere public

- `CORSMiddleware` is currently `allow_origins=["*"]` for local-dev
  convenience — lock this down to your actual frontend origin.
- No auth on any endpoint — add it before this is reachable from the
  internet with real data in it.
- Uploaded data lives in server memory until you call `DELETE` or
  restart the process — add a TTL/eviction policy for a long-running
  deployment.
