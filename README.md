# Spatial Arcs — React

Interactive OD (origin-destination) flow visualizer for Chennai transit data —
an arc diagram that morphs into a true geographic map, with animated
particles flowing along each route.

Rebuilt from the original single-file HTML prototype into a proper
Vite + React + TypeScript app.

## Stack

- **Vite + React + TypeScript** — dev server, HMR, typed components
- **Canvas 2D** — the diagram itself is rendered imperatively on a `<canvas>`
  inside a React component (via refs), not as DOM/SVG nodes. This is what
  lets it stay smooth with thousands of arcs + flow particles animating at once.
- **Zustand** — small global store for app state (dataset, view mode, filters,
  backend connection). The canvas subscribes to it directly so animation
  frames don't trigger React re-renders.
- **D3** (`d3-geo`, `d3-scale`, `d3-format`) — Mercator projection and the
  color/radius/width scales mapped to trip volume and stop demand.
- **Framer Motion** — the Arc/Geo toggle's sliding pill and the settings
  panel's open/close animation.

## Project layout

```
src/
  lib/
    types.ts     shared TypeScript types
    csv.ts        CSV parsing + auto column detection
    layout.ts     geo projection, arc layout, scales, easing/lerp math
    api.ts        backend fetch/upload helpers
  store/
    useFlowStore.ts   zustand store (nodes, edges, mode, filters, api state)
  components/
    FlowCanvas.tsx    canvas render loop + mouse interaction
    Tooltip.tsx
    ModeToggle.tsx    Arc / Geo switch
    SettingsPanel.tsx search, top-N slider, backend connect, CSV upload
  data/
    sample.ts     bundled Chennai sample dataset
  App.tsx
  app.css
backend/          FastAPI + DuckDB + H3 service (unchanged, see backend/README.md)
```

## Quick start

```bash
npm install
npm run dev
```

Open the printed local URL. The app boots with a small bundled Chennai
sample dataset in "local mode."

To connect the real backend for large datasets:

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Then in the app's settings panel (gear icon, top right), paste
`http://localhost:8000` into **Backend URL**, hit **Connect**, and
**Upload CSV**.

Expected CSV columns (auto-detected by name + type): an origin id/name, a
destination id/name, origin lat/lon, destination lat/lon, and a trip count
column.

## Build

```bash
npm run build
```

Outputs a static bundle to `dist/` — deployable anywhere (Vercel, Netlify,
S3 + CloudFront, etc). No server needed for the frontend itself; only the
optional backend needs Python hosting.
