import { motion } from 'framer-motion';
import { useFlowStore } from '../store/useFlowStore';
import type { ViewMode } from '../lib/types';

const OPTIONS: { key: ViewMode; label: string }[] = [
  { key: 'arc', label: 'Arc' },
  { key: 'geo', label: 'Geo' },
];

export function ModeToggle() {
  const mode = useFlowStore((s) => s.mode);
  const setMode = useFlowStore((s) => s.setMode);

  return (
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
  );
}
