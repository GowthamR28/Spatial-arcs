import { useCallback, useEffect, useState } from 'react';
import { FlowCanvas } from './components/FlowCanvas';
import { Tooltip } from './components/Tooltip';
import { ModeToggle } from './components/ModeToggle';
import { SettingsPanel } from './components/SettingsPanel';
import { initSample } from './store/useFlowStore';
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

  useEffect(() => {
    initSample();
  }, []);

  const handleHover = useCallback((t: TooltipState) => setTooltip(t), []);

  return (
    <div className="app">
      <FlowCanvas onHover={handleHover} />
      <Tooltip {...tooltip} />
      <ModeToggle />
      <SettingsPanel />
      <div className="brand">
        <span className="brand-mark" />
        Spatial Arcs <span className="brand-sub">· Chennai Transit OD</span>
      </div>
    </div>
  );
}
