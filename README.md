# Spatial Arcs

Interactive origin–destination (OD) flow visualizer. Routes render as smooth,
colored arcs with particles animating along them — flip a toggle and the
whole layout *morphs* into a real geographic map, in 3D if you want it.

Ships with a bundled Chennai transit sample, but it's built to take **any**
origin/destination CSV — flights, deliveries, migration, call routing,
whatever your OD pairs are.

## Features

- **Arc ⇄ Geo morph** — not a hard cut between two states, an animated
  blend from abstract arc diagram to true Mercator-projected map
- **3D orbit camera** — fly around the map with WASD, or let "Auto Cinema"
  fly itself
- **Animated flow particles** along every visible route
- **Top‑N playback** — hit play and watch routes build up from busiest to
  least busy, like a time-lapse, instead of manually dragging a slider
- **7 color palettes**, cycle with `[` / `]`
- **4 classification methods** — quantile, equal interval, natural breaks
  (Jenks), log — pick whichever fits how skewed your data is
- **Search / highlight** a specific stop or node
- **Click‑to‑isolate** a node's routes; double‑click to reset the view
- Renders 100k+ edges in a single GPU draw call (WebGL instancing), so it
  stays smooth at real-world dataset sizes
- Optional backend for large files: auto-detects columns, and when a
  dataset has too many nodes to render cleanly, auto-clusters it with H3
  hexagons rather than silently dropping data

## Tech stack

| | |
|---|---|
| Frontend | Vite + React + TypeScript |
| Rendering | Canvas 2D (labels/UI) + WebGL (instanced edge rendering) |
| State | Zustand — canvas subscribes directly, so animation frames don't trigger React re-renders |
| Geo/scales | D3 (`d3-geo`, `d3-scale`, `d3-format`) |
| Motion | Framer Motion (toggle pill, panel transitions) |
| Backend (optional) | FastAPI + DuckDB + H3, for column auto-detection and clustering at scale |

## Quick start

```bash
npm install
npm run dev
```

Open the printed local URL. The app boots straight into "local mode" with a
bundled Chennai sample dataset — no backend required to try it out.

```bash
npm run build     # production build → dist/
npm run preview   # preview the production build locally
npm run lint       # oxlint
```

`dist/` is a static bundle — deployable anywhere (Vercel, Netlify, GitHub
Pages, S3 + CloudFront). The backend is only needed for large uploaded
datasets; the frontend works standalone otherwise.

## Bringing your own data

Click the **gear icon** (top right) → **Upload CSV**. No backend needed for
small-to-medium files — parsing happens in a Web Worker so the UI thread
stays responsive.

### Required columns

Your CSV needs, at minimum, an origin id, a destination id, a lat/lon for
each end, and a trip count/weight column. Column **names are auto-detected**
by keyword matching, so you don't need to match an exact schema — any of
these patterns work:

| What it means | Header patterns it looks for |
|---|---|
| Origin id | `origin`, `from`, `source`, `org` |
| Origin name *(optional)* | a second `origin`/`from`/`org`‑style column |
| Origin latitude | `org_lat`, `origin_lat`, `o_lat`, `from_lat`, `start_lat`, `src_lat` |
| Origin longitude | `org_lon`, `origin_lon`, `org_lng`, `o_lon`, `from_lon`, `start_lon`, `src_lon` |
| Destination id | `destination`, `dest`, `to`, `target` |
| Destination name *(optional)* | a second `destination`/`dest`/`to`‑style column |
| Destination latitude | `dest_lat`, `destination_lat`, `d_lat`, `to_lat`, `end_lat` |
| Destination longitude | `dest_lon`, `destination_lon`, `dest_lng`, `d_lon`, `to_lon`, `end_lon` |
| Trip count / weight | `trips`, `value`, `count`, `weight`, `flow`, `volume` (falls back to the first numeric column left over if none of these match) |

Matching is case-insensitive and works on substrings, so `Origin_Lat`,
`org_latitude`, and `from_lat` all resolve the same way. If you have **two**
columns that both look like "origin" (e.g. a numeric stop ID *and* a stop
name), it's smart enough to use the numeric one as the id and the text one
as the display name.

### Example CSV

```csv
origin,origin_name,destination,destination_name,org_lat,org_lon,dest_lat,dest_lon,trips
3,Broadway,12,Clive Battery,13.08820568,80.28388983,13.09969646,80.2940232,367
3,Broadway,17,Vallalar Nagar Bus Depot,13.08820568,80.28388983,13.10425522,80.27597223,319
9,Vasanthi Amman Koil,3,Broadway,13.0983348,80.280977,13.08820568,80.28388983,2
```

Rows sharing the same origin+destination pair are automatically summed into
a single edge, so it's fine to upload raw, un-aggregated trip-level data.

### Large datasets (backend)

For files too large to comfortably parse and render in-browser, spin up the
optional backend:

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Then in the settings panel, paste `http://localhost:8000` into **Backend
URL**, hit **Connect**, and **Upload CSV** again — it now uploads to the
server instead of parsing client-side. This is what lets the top‑N slider
re-query the server rather than re-slicing a giant array on the main thread,
and what triggers automatic H3 clustering once the node count would
overwhelm the renderer. Full API + clustering details in
[`backend/README.md`](backend/README.md).

**Before deploying the backend publicly:** it ships with `CORSMiddleware`
wide open and no auth — see the backend README for what to lock down first.

## Controls

| Input | Action |
|---|---|
| `space` | Play/pause the top‑N build-up (loops) |
| `← →` | Step top‑N (hold `shift` for a bigger jump) |
| `[` `]` | Cycle color palette |
| `Home` / `End` | Jump to fewest / all routes |
| Scroll | Zoom |
| Drag | Pan |
| Click a node | Isolate its routes |
| Double‑click | Reset view |
| `Esc` | Stop play / exit cinema mode |
| **In 3D geo mode:** `w a s d` | Fly |
| `q` / `e` | Fly up / down |
| Right‑drag | Orbit |
| `c` | Toggle Auto Cinema (camera flies itself) |

## Project layout

```
src/
  lib/
    types.ts          shared TypeScript types
    csv.ts             CSV parsing + column auto-detection + aggregation
    csv.worker.ts       runs the above off the main thread
    layout.ts           geo projection, arc layout, scales, easing/lerp math
    classification.ts   quantile / equal / natural-breaks / log binning
    palettes.ts          color ramps
    glEdges.ts            WebGL instanced edge renderer
    mat4.ts                camera/projection matrix math for 3D mode
    api.ts                 backend connect/upload/fetch helpers
  store/
    useFlowStore.ts    zustand store — nodes, edges, mode, filters, api state
  components/
    FlowCanvas.tsx     canvas render loop + mouse/keyboard interaction
    Tooltip.tsx
    ModeToggle.tsx     Arc / Geo switch, 3D toggle, cinema toggle
    SettingsPanel.tsx  search, top-N slider + play, palette/classification pickers, backend connect, CSV upload
  data/
    sample.ts          bundled Chennai sample dataset
  App.tsx              layout, keyboard shortcuts, play/pause loop
  app.css
backend/               optional FastAPI + DuckDB + H3 service — see backend/README.md
```

## Contributing

Issues and PRs welcome — this started as a single-file HTML prototype and
got rebuilt into a proper app, so there's plenty of room to extend (more
classification methods, more palettes, other projections, etc). If you add
a feature, a quick note in this README's Features list is appreciated.

## License

MIT — see [`LICENSE`](LICENSE). *(Add a `LICENSE` file before publishing if
one isn't in the repo yet — MIT is a reasonable default for this kind of
project.)*