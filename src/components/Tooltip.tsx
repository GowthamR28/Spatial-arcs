import { fmt } from './FlowCanvas';

interface Props {
  visible: boolean;
  x: number;
  y: number;
  name: string;
  demand: number;
}

export function Tooltip({ visible, x, y, name, demand }: Props) {
  return (
    <div
      className="tooltip"
      style={{
        left: x,
        top: y,
        opacity: visible ? 1 : 0,
      }}
    >
      <b>{name}</b>
      <div className="route">
        Total demand · <span className="val">{fmt(Math.round(demand))}</span> trips
      </div>
    </div>
  );
}
