import type { DroneState } from '../types';

// The schematic reads the palette through CSS variables (see index.css) so it
// tracks the light/dark toggle.
const C = {
  canvas: 'var(--af-canvas)',
  panel: 'var(--af-panel)',
  line: 'var(--af-line)',
  lineStrong: 'var(--af-line-strong)',
  text: 'var(--af-text)',
  textSubtle: 'var(--af-text-subtle)',
  accent: 'var(--af-accent)',
};

interface SchematicNode {
  /** Module name as published by the drone session (see SCAN_TARGETS). */
  module: string;
  label: string;
  x: number;
  y: number;
  labelX: number;
  labelY: number;
  anchor: 'start' | 'middle' | 'end';
}

// Top-down view, nose up. Motors follow DJI numbering: M1 front right, then
// counter-clockwise.
const MOTORS = [
  { x: 250, y: 50 },
  { x: 70, y: 50 },
  { x: 70, y: 190 },
  { x: 250, y: 190 },
];

const NODES: SchematicNode[] = [
  { module: 'Flight controller', label: 'FC', x: 160, y: 103, labelX: 169, labelY: 106.5, anchor: 'start' },
  { module: 'Camera', label: 'CAM', x: 153, y: 68, labelX: 156, labelY: 50, anchor: 'end' },
  { module: 'Gimbal', label: 'GIM', x: 167, y: 68, labelX: 164, labelY: 50, anchor: 'start' },
  { module: 'Battery', label: 'BAT', x: 160, y: 132, labelX: 160, labelY: 150, anchor: 'middle' },
  ...MOTORS.map((motor, index) => ({
    module: `ESC ${index + 1}`,
    label: `M${index + 1}`,
    x: motor.x,
    y: motor.y,
    labelX: motor.x,
    labelY: motor.y + 20,
    anchor: 'middle' as const,
  })),
];

/** How many modules have a place on the schematic. */
export const SCHEMATIC_NODE_COUNT = NODES.length;

/**
 * Top-down outline of the aircraft whose nodes light up as the matching
 * modules answer the version scan.
 */
function AircraftSchematic({ drone }: { drone: DroneState }) {
  const connected = drone.status === 'connected';
  const answered = new Set(connected ? drone.modules.map((module) => module.name) : []);
  const lit = NODES.filter((node) => answered.has(node.module)).length;
  const frame = connected ? C.lineStrong : C.line;

  return (
    <svg
      viewBox="0 0 320 240"
      width="100%"
      style={{ maxWidth: 340, display: 'block' }}
      role="img"
      aria-label={
        connected
          ? `Aircraft schematic: ${lit} of ${NODES.length} mapped modules answered`
          : 'Aircraft schematic: searching for an aircraft'
      }
    >
      {!connected && (
        <g fill="none" stroke={C.accent} strokeWidth="1">
          <circle className="sweep" cx="160" cy="120" r="112" />
          <circle className="sweep sweep-late" cx="160" cy="120" r="112" />
        </g>
      )}

      <g fill="none" stroke={frame} strokeWidth="1.5" strokeLinecap="round">
        {/* Arms */}
        <path d="M138 86 70 50M182 86 250 50M138 154 70 190M182 154 250 190" strokeWidth="5" />
        {/* Rotor discs */}
        {MOTORS.map((motor) => (
          <circle
            key={`${motor.x}-${motor.y}`}
            cx={motor.x}
            cy={motor.y}
            r="32"
            strokeWidth="1"
            strokeDasharray="2 5"
          />
        ))}
        {/* Nose marker */}
        <path d="M154 30l6-6 6 6" strokeWidth="1.25" />
      </g>

      <g fill={C.panel} stroke={frame} strokeWidth="1.5">
        {/* Gimbal and camera pod */}
        <rect x="146" y="58" width="28" height="22" rx="7" />
        {/* Body */}
        <rect x="132" y="76" width="56" height="88" rx="17" />
        {/* Battery */}
        <rect x="143" y="121" width="34" height="34" rx="6" strokeWidth="1" />
        {/* Motor hubs */}
        {MOTORS.map((motor) => (
          <circle key={`${motor.x}-${motor.y}`} cx={motor.x} cy={motor.y} r="9" />
        ))}
      </g>

      {NODES.map((node) => {
        const on = answered.has(node.module);
        return (
          <g key={node.module} className={connected && drone.scanning && !on ? 'blink' : undefined}>
            <title>{`${node.module}: ${on ? 'answered' : 'no reply'}`}</title>
            {on && <circle cx={node.x} cy={node.y} r="8.5" fill={C.accent} opacity="0.2" />}
            <circle
              cx={node.x}
              cy={node.y}
              r={on ? 4 : 3.5}
              fill={on ? C.accent : C.canvas}
              stroke={on ? C.accent : C.lineStrong}
              strokeWidth="1.25"
            />
            <text
              x={node.labelX}
              y={node.labelY}
              textAnchor={node.anchor}
              // As styles, not attributes: the CSS reset outranks SVG
              // presentation attributes for font properties.
              style={{
                fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
                fontSize: '9.5px',
                letterSpacing: '0.04em',
              }}
              fill={on ? C.text : C.textSubtle}
            >
              {node.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default AircraftSchematic;
