import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import * as d3 from 'd3';
import { useFlowStore } from '../store/useFlowStore';
import { connectToBackend, debouncedServerFetch, uploadToBackend } from '../lib/api';
import { PALETTES } from '../lib/palettes';
import { CLASSIFICATION_METHODS } from '../lib/classification';

const STATUS_LABEL: Record<string, string> = {
  local: 'local mode',
  connecting: 'connecting…',
  connected: 'connected',
  error: 'unreachable',
  uploading: 'uploading…',
  'upload-failed': 'upload failed',
};

export function SettingsPanel() {
  const [open, setOpen] = useState(false);
  const [apiInput, setApiInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const topN = useFlowStore((s) => s.topN);
  const maxTopN = useFlowStore((s) => s.maxTopN);
  const setTopN = useFlowStore((s) => s.setTopN);
  const setFilterText = useFlowStore((s) => s.setFilterText);
  const apiStatus = useFlowStore((s) => s.apiStatus);
  const backendMode = useFlowStore((s) => s.backendMode);
  const nodesCount = useFlowStore((s) => s.nodes.size);
  const nodesMap = useFlowStore((s) => s.nodes);
  const edgesRaw = useFlowStore((s) => s.edgesRaw);
  const meta = useFlowStore((s) => s.meta);
  const ingestFromFile = useFlowStore((s) => s.ingestFromFile);
  const loading = useFlowStore((s) => s.loading);
  const loadError = useFlowStore((s) => s.loadError);
  const paletteId = useFlowStore((s) => s.paletteId);
  const setPalette = useFlowStore((s) => s.setPalette);
  const classification = useFlowStore((s) => s.classification);
  const setClassification = useFlowStore((s) => s.setClassification);

  const total = d3.sum(edgesRaw, (e) => e.value);
  const visibleEdgeCount = Math.min(topN, edgesRaw.length);
  // How many distinct stops the currently-shown top-N routes actually touch —
  // this is what changes when you move the slider, not the dataset total.
  const visibleStopCount = useMemo(() => {
    const ids = new Set<string>();
    for (let i = 0; i < visibleEdgeCount; i++) {
      const e = edgesRaw[i];
      if (nodesMap.has(e.sourceId)) ids.add(e.sourceId);
      if (nodesMap.has(e.targetId)) ids.add(e.targetId);
    }
    return ids.size;
  }, [edgesRaw, visibleEdgeCount, nodesMap]);
  const badgeClass = apiStatus === 'connected' ? 'connected' : apiStatus === 'error' || apiStatus === 'upload-failed' ? 'error' : '';

  let extra = '';
  if (meta?.clustered) extra = ` · clustered (H3 res ${meta.resolution})`;
  else if (meta?.query_time_ms !== undefined) extra = ` · ${meta.query_time_ms}ms server`;

  useEffect(() => {
    if (!open) return;
    function onDocClick() {
      setOpen(false);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open]);

  function handleTopNChange(v: number) {
    setTopN(v);
    if (backendMode && useFlowStore.getState().datasetId) {
      debouncedServerFetch();
    }
  }

  function handleFile(file: File) {
    if (backendMode && useFlowStore.getState().apiBase) {
      uploadToBackend(file);
      return;
    }
    // Parsing + aggregation happens in a Web Worker (see lib/csv.worker.ts) —
    // the UI thread stays responsive even for a 50k-row file.
    ingestFromFile(file);
  }

  return (
    <>
      <button
        className={'icon-btn' + (open ? ' open' : '')}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title="Settings"
      >
        <GearIcon />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            className="settings-panel"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="text"
              placeholder="Highlight a place…"
              onChange={(e) => setFilterText(e.target.value)}
            />

            <div className="slider-wrap">
              Top <span className="mono-val">{topN}</span>
              <input
                type="range"
                min={10}
                max={Math.max(10, maxTopN)}
                value={topN}
                onChange={(e) => handleTopNChange(+e.target.value)}
              />
              {topN > 5000 && <span className="stats-extra">high values may reduce fps</span>}
            </div>

            <div className="stats">
              {loading ? (
                'parsing…'
              ) : (
                <>
                  <b>{visibleEdgeCount}</b> of {edgesRaw.length} routes ·{' '}
                  <b>{d3.format(',')(Math.round(total))}</b> trips ·{' '}
                  <b>{visibleStopCount}</b> of {nodesCount} stops shown
                  {extra && <span className="stats-extra">{extra}</span>}
                </>
              )}
              {loadError && <span className="stats-extra error">{loadError}</span>}
            </div>

            <div className="palette-picker">
              {PALETTES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={'palette-swatch' + (p.id === paletteId ? ' active' : '')}
                  title={p.name}
                  onClick={() => setPalette(p.id)}
                >
                  {p.colors.map((c, i) => (
                    <span key={i} style={{ background: c }} />
                  ))}
                </button>
              ))}
            </div>

            <div className="classification-picker">
              {CLASSIFICATION_METHODS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={'classification-chip' + (m.id === classification ? ' active' : '')}
                  title={m.blurb}
                  onClick={() => setClassification(m.id)}
                >
                  {m.name}
                </button>
              ))}
            </div>

            <div className="settings-row">
              <input
                type="text"
                placeholder="Backend URL…"
                value={apiInput}
                onChange={(e) => setApiInput(e.target.value)}
              />
              <button className="ghost-btn" onClick={() => connectToBackend(apiInput)}>
                Connect
              </button>
            </div>

            <div className="settings-row">
              <span className={'api-badge' + (badgeClass ? ' ' + badgeClass : '')}>
                {STATUS_LABEL[apiStatus]}
              </span>
              <label
                className={'ghost-btn upload-btn' + (loading ? ' disabled' : '')}
                onClick={() => !loading && fileInputRef.current?.click()}
              >
                {loading ? 'Parsing…' : 'Upload CSV'}
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                disabled={loading}
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                  e.target.value = '';
                }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}