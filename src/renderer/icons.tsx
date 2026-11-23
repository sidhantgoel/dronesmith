import type { ReactNode } from 'react';

interface IconProps {
  size?: number;
}

function Svg({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function DroneIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="5" r="2.5" />
      <circle cx="19" cy="5" r="2.5" />
      <circle cx="5" cy="19" r="2.5" />
      <circle cx="19" cy="19" r="2.5" />
      <rect x="9" y="9" width="6" height="6" rx="1.5" />
      <path d="M6.8 6.8 9.3 9.3M17.2 6.8l-2.5 2.5M6.8 17.2l2.5-2.5M17.2 17.2l-2.5-2.5" />
    </Svg>
  );
}

export function RemoteIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <circle cx="9" cy="7" r="1.1" />
      <circle cx="15" cy="7" r="1.1" />
      <path d="M12 11v4M10 13h4" />
      <path d="M9.5 18.5h5" />
    </Svg>
  );
}

export function MotorIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="2.2" />
      <path d="M12 9.8C12 6 9.5 4 6.5 4.5c.3 3 2.3 5.3 5.5 5.3zM13.9 13.1c3.3 1.9 6.3.7 7.3-2.1-2.7-1.2-5.7-.6-7.3 2.1zM10.1 13.1c-3.3 1.9-3.8 5.1-1.8 7.4 2.4-1.8 3.4-4.7 1.8-7.4z" />
    </Svg>
  );
}

/** A chip with three axes, for the inertial sensor. */
export function ImuIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M12 7V3M10.5 4.5 12 3l1.5 1.5M17 12h4M19.5 10.5 21 12l-1.5 1.5M7 17l-3 3M4 17.8V20h2.2" />
    </Svg>
  );
}

export function BatteryIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="7" width="16.5" height="10" rx="2" />
      <path d="M21.5 10.5v3M6 10.5v3M9.5 10.5v3" />
    </Svg>
  );
}

/** A dial with a needle, for live readings. */
export function TelemetryIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 17a8.5 8.5 0 1 1 16 0" />
      <path d="m12 14 3.5-4.5" />
      <circle cx="12" cy="14.5" r="1.2" />
    </Svg>
  );
}

/** A checklist, for the full check. */
export function ChecklistIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <path d="m7.5 9 1.5 1.5L11.5 8M14 9.5h3M7.5 15l1.5 1.5 2.5-2.5M14 15.5h3" />
    </Svg>
  );
}

/** A plaster, for repairs. */
export function RepairIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="8.5" width="20" height="7" rx="3.5" transform="rotate(-45 12 12)" />
      <path d="M10.5 12h.01M13.5 12h.01M12 10.5v.01M12 13.5v.01" />
    </Svg>
  );
}

/** A terminal prompt, for the command console. */
export function ConsoleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7 9.5 3 2.5-3 2.5M12.5 15H17" />
    </Svg>
  );
}

export function PartitionIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M11 10v10" />
      <circle cx="6.5" cy="7" r="0.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function ParamIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="18" r="2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function CalibrateIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="1.5" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </Svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M10 11v6M14 11v6" />
    </Svg>
  );
}

export function PanelRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12.5 9.5 17 19 7.5" />
    </Svg>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4 21 20H3zM12 10v4M12 17v.01" />
    </Svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 5.5v13l10.5-6.5z" />
    </Svg>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" />
    </Svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 13.5A8 8 0 0 1 10.5 4 7 7 0 1 0 20 13.5z" />
    </Svg>
  );
}

export function FirmwareIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9.5 2.5v3M14.5 2.5v3M9.5 18.5v3M14.5 18.5v3M2.5 9.5h3M2.5 14.5h3M18.5 9.5h3M18.5 14.5h3" />
      <path d="M12 9v3.5l2 1.5" />
    </Svg>
  );
}

/** A folder, for the drone's files over USB. */
export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 6.5a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Svg>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
      <path d="M13 3v6h6" />
    </Svg>
  );
}

export function HealthIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12h4l2-5 3 10 2.5-6 1.5 3H21" />
    </Svg>
  );
}

export function ToolsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14.5 5.5a3.5 3.5 0 0 0 4.4 4.4l-8 8a2.1 2.1 0 0 1-3-3z" />
      <path d="M6 14l-2 2a2.1 2.1 0 0 0 3 3l2-2" />
    </Svg>
  );
}
