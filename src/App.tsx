import { useCallback, useEffect, useRef, useState } from 'react';
import { FlowCanvas } from './components/FlowCanvas';
import { Tooltip } from './components/Tooltip';
import { ModeToggle } from './components/ModeToggle';
import { SettingsPanel } from './components/SettingsPanel';
import { initSample, useFlowStore } from './store/useFlowStore';
import { ease, lerp } from './lib/layout';
import './app.css';

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  name: string;
  demand: number;
}

export default function App() {
  const [tooltip, setTooltip] = useState<TooltipState>({ visible: false, x: 0, y: 0, name: '', demand: 0 });
  const selectedNodeId = useFlowStore((s) => s.selectedNodeId);
  const setSelectedNode = useFlowStore((s) => s.setSelectedNode);
  const selectedNode = useFlowStore((s) => (s.selectedNodeId ? s.nodes.get(s.selectedNodeId) : undefined));
  const isPlaying = useFlowStore((s) => s.isPlaying);

  useEffect(() => {
    initSample();
  }, []);

  const handleHover = useCallback((t: TooltipState) => setTooltip(t), []);

  // "Play" — counts topN up from 1 to the full dataset over a slow, steady
  // stretch, like a video of trip pairs being added one after another,
  // instead of manually nudging the slider one step at a time. Loops back
  // to 1 and keeps going until explicitly paused/stopped.
  const PLAY_DURATION_MS = 18000; // 50% slower than the original 9s pass
  const playFromRef = useRef(1);
  const playStartRef = useRef(0);
  const rafRef = useRef(0);
  const lastPlayUpdateRef = useRef(0);

  useEffect(() => {
    if (!isPlaying) return;
    const { topN, maxTopN, setTopN } = useFlowStore.getState();
    // Resume from where you paused; if you're already at (or past) the end,
    // start the "video" over from the beginning instead of doing nothing.
    playFromRef.current = topN >= maxTopN ? 1 : topN;
    if (playFromRef.current === 1) setTopN(1);
    playStartRef.current = performance.now();
    lastPlayUpdateRef.current = 0;

    function tick(now: number) {
      const { maxTopN: max, isPlaying: playing } = useFlowStore.getState();
      if (!playing) return;
      const progress = Math.min((now - playStartRef.current) / PLAY_DURATION_MS, 1);
      const done = progress >= 1;
      // Recomputing the edge/GL buffers is O(topN) — for large datasets,
      // driving that every single animation frame (60/sec) is wasted work
      // the eye can't even see. ~25 updates/sec still reads as smooth
      // motion, so throttle to that unless this is the final frame.
      if (done || now - lastPlayUpdateRef.current >= 40) {
        lastPlayUpdateRef.current = now;
        const n = Math.round(lerp(playFromRef.current, max, ease(progress)));
        if (n !== useFlowStore.getState().topN) setTopN(Math.max(1, n));
      }
      if (done) {
        // Loop: start the next pass from 1 rather than stopping — keeps
        // running until the user pauses (space/Esc) or touches the slider.
        playFromRef.current = 1;
        playStartRef.current = now;
        lastPlayUpdateRef.current = 0;
        setTopN(1);
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying]);

  // Keyboard shortcuts — ignored while typing in a text field so they don't
  // interfere with the highlight/backend-URL inputs.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing) return;

      const store = useFlowStore.getState();

      switch (e.key) {
        case ' ':
        case 'Spacebar':
          // Play/pause the trip-pairs build-up.
          e.preventDefault();
          store.setIsPlaying(!store.isPlaying);
          break;
        case 'Escape':
          if (store.isPlaying) store.setIsPlaying(false);
          if (store.cinemaMode) store.setCinemaMode(false);
          break;
        case 'ArrowRight':
        case 'ArrowUp': {
          // In 3D these drive the cinematic flight instead (see FlowCanvas)
          // — leave them alone here so the two don't fight over the keys.
          const s = useFlowStore.getState();
          if (s.mode === 'geo' && s.geo3D) break;
          // A single native slider arrow-key press only moves topN by 1 —
          // painfully slow on a dataset with thousands of routes. These
          // jump by a percentage of the full range instead (bigger with
          // Shift held), and stop any running "play" so they don't fight it.
          e.preventDefault();
          if (store.isPlaying) store.setIsPlaying(false);
          const step = Math.max(1, Math.round(store.maxTopN * (e.shiftKey ? 0.1 : 0.02)));
          store.stepTopN(step);
          break;
        }
        case 'ArrowLeft':
        case 'ArrowDown': {
          const s = useFlowStore.getState();
          if (s.mode === 'geo' && s.geo3D) break;
          e.preventDefault();
          if (store.isPlaying) store.setIsPlaying(false);
          const step = Math.max(1, Math.round(store.maxTopN * (e.shiftKey ? 0.1 : 0.02)));
          store.stepTopN(-step);
          break;
        }
        case 'c':
        case 'C': {
          e.preventDefault();
          const s = useFlowStore.getState();
          s.setCinemaMode(!s.cinemaMode);
          break;
        }
        case '[':
          store.cyclePalette(-1);
          break;
        case ']':
          store.cyclePalette(1);
          break;
        case 'Home':
          e.preventDefault();
          if (store.isPlaying) store.setIsPlaying(false);
          store.setTopN(1);
          break;
        case 'End':
          e.preventDefault();
          if (store.isPlaying) store.setIsPlaying(false);
          store.setTopN(store.maxTopN);
          break;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="app">
      <FlowCanvas onHover={handleHover} />
      <Tooltip {...tooltip} />
      <ModeToggle />
      <SettingsPanel />
      {selectedNodeId && (
        <button className="isolate-banner" onClick={() => setSelectedNode(null)} title="Clear selection">
          Showing only <b>{selectedNode?.name ?? selectedNodeId}</b>
          <span className="isolate-clear">✕</span>
        </button>
      )}
      <div className="key-hints" title="Keyboard shortcuts">
        <kbd>space</kbd> play routes (loops) · <kbd>←</kbd><kbd>→</kbd> top N (+<kbd>shift</kbd> bigger) · <kbd>[</kbd><kbd>]</kbd> palette · in 3D: <kbd>c</kbd> auto cinema, <kbd>w</kbd><kbd>a</kbd><kbd>s</kbd><kbd>d</kbd> fly, <kbd>q</kbd><kbd>e</kbd> up/down
      </div>
      <div className="brand">
        <span className="brand-mark" />
        Spatial Arcs <span className="brand-sub">· Chennai Transit OD</span>
      </div>
    </div>
  );
}
