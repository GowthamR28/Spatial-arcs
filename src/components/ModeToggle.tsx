import { motion, AnimatePresence } from 'framer-motion';
import { useFlowStore } from '../store/useFlowStore';
import type { ViewMode } from '../lib/types';

const OPTIONS: { key: ViewMode; label: string }[] = [
  { key: 'arc', label: 'Arc' },
  { key: 'geo', label: 'Geo' },
];

export function ModeToggle() {
  const mode = useFlowStore((s) => s.mode);
  const setMode = useFlowStore((s) => s.setMode);
  const geo3D = useFlowStore((s) => s.geo3D);
  const setGeo3D = useFlowStore((s) => s.setGeo3D);

  return (
    <div className="mode-toggle-row">
      <div className="mode-toggle">
        {OPTIONS.map((opt) => (
          <button
            key={opt.key}
            className={mode === opt.key ? 'active' : ''}
            onClick={() => setMode(opt.key)}
          >
            {mode === opt.key && (
              <motion.span
                layoutId="mode-pill"
                className="mode-pill"
                transition={{ type: 'spring', stiffness: 500, damping: 35 }}
              />
            )}
            <span className="mode-label">{opt.label}</span>
          </button>
        ))}
      </div>
      <AnimatePresence>
        {mode === 'geo' && (
          <motion.button
            key="geo3d-toggle"
            className={'geo3d-toggle' + (geo3D ? ' active' : '')}
            onClick={() => setGeo3D(!geo3D)}
            title="Orbit-camera 3D view — height encodes distance/demand"
            initial={{ opacity: 0, scale: 0.85, x: -6 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.85, x: -6 }}
            transition={{ duration: 0.18 }}
          >
            3D
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
