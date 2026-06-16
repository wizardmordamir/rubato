// Inline stroke icons (Feather/Lucide style), drawn in `currentColor` so they
// inherit text color. No icon-font or runtime dependency. Deliberately distinct
// from the sibling app's icon set: settings is a sliders glyph (not a gear) and
// the theme toggle uses sun/moon (not a contrast half-circle).

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

// Theme toggle: sun (shown in dark mode to offer "go light") …
export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </Svg>
);

// … and moon (shown in light mode to offer "go dark").
export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </Svg>
);

// Settings — a sliders/mixer glyph (fitting for a "rubato" tooling app).
export const IconSliders = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
    <path d="M1 14h6M9 8h6M17 16h6" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

// A document/notes glyph — used for the System Files editor link.
export const IconFileText = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M8 13h8M8 17h8M8 9h2" />
  </Svg>
);

// Code-brackets glyph (`</>`) — "open this path in the editor".
export const IconCode = (p: IconProps) => (
  <Svg {...p}>
    <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
  </Svg>
);

// Open-external glyph (box with an out-arrow) — "open this elsewhere".
export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 3h6v6M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </Svg>
);

// Maximize (four corner brackets opening out) — "fill the screen".
export const IconMaximize = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
  </Svg>
);

// Minimize (four corner brackets closing in) — "leave full screen".
export const IconMinimize = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
  </Svg>
);

export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4l14 8-14 8V4z" />
  </Svg>
);

// A filled square — the universal "stop" glyph, pairing with IconPlay.
export const IconSquare = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
  </Svg>
);

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Svg>
);

// Shown briefly after a successful copy.
export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);

// Auto-scroll toggle — a downward arrow into a baseline; lit (accent) when the
// Ask thread auto-pins to the latest streaming output.
export const IconScrollDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Svg>
);

// Debug toggle — a bug glyph; lit (accent) when the AI debug panel is on.
export const IconBug = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8" y="6" width="8" height="14" rx="4" />
    <path d="M9 6a3 3 0 0 1 6 0M3 9l3 1M21 9l-3 1M3 15l3-1M21 15l-3-1M3 20l3-3M21 20l-3-3M8 13H4M20 13h-4" />
  </Svg>
);

// Reveal — an open eye; shows a hidden value (e.g. a masked secret).
export const IconEye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

// Hide — an eye with a slash; re-masks a revealed value.
export const IconEyeOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <path d="M1 1l22 22" />
  </Svg>
);

// Hamburger — opens the mobile nav drawer.
export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </Svg>
);

// Close (X) — dismisses the mobile nav drawer / overlays.
export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

// Drag handle — a six-dot grip; press-and-drag to reorder a list item.
export const IconGrip = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="6" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="18" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="6" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="18" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
);

// ── Nav / hub / page glyphs ───────────────────────────────────────────────────
// Used by the color-coded sidebar entries and the hub tiles (see navMeta.tsx).

// Apps — a 2×2 grid of tiles.
export const IconApps = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </Svg>
);

// Dashboard — a gauge.
export const IconDashboard = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 1 0-18 0" />
    <path d="M12 12l4-2.5" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </Svg>
);

// Analytics — a bar chart (Orchestration Processing).
export const IconChartBar = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3v18h18" />
    <rect x="7" y="11" width="3" height="6" />
    <rect x="12" y="7" width="3" height="10" />
    <rect x="17" y="13" width="3" height="4" />
  </Svg>
);

// Data — a database cylinder.
export const IconDatabase = (p: IconProps) => (
  <Svg {...p}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
  </Svg>
);

// Automation — a lightning bolt.
export const IconZap = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
  </Svg>
);

// Results / files — a folder.
export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);

// Security — a shield.
export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 2 4 5v6c0 5 3.5 8 8 11 4.5-3 8-6 8-11V5z" />
  </Svg>
);

// Excel — a table grid.
export const IconTable = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18M9 4v16" />
  </Svg>
);

// Ask — a chat bubble.
export const IconChat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8A8.38 8.38 0 0 1 12.5 3a8.38 8.38 0 0 1 8.5 8.5z" />
  </Svg>
);

// Board — kanban columns.
export const IconColumns = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="5" height="18" rx="1" />
    <rect x="10" y="3" width="5" height="18" rx="1" />
    <rect x="17" y="3" width="4" height="18" rx="1" />
  </Svg>
);

// Tools — a wrench.
export const IconWrench = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2-2 2.6-2.6z" />
  </Svg>
);

// Docs — an open book.
export const IconBook = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
  </Svg>
);

// Splunk / search — a magnifier.
export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
);

// ServiceNow / requests — a globe.
export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" />
  </Svg>
);

// Session — stacked layers.
export const IconLayers = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 2 9 5-9 5-9-5 9-5z" />
    <path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
  </Svg>
);

// Commands — a terminal prompt.
export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 17 6-5-6-5M12 19h8" />
  </Svg>
);

// Pipelines — a branch graph.
export const IconGitBranch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="8" r="2.5" />
    <path d="M6 8.5v7M18 10.5a6 6 0 0 1-6 6H8.5" />
  </Svg>
);

// Capture — a camera.
export const IconCamera = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
    <circle cx="12" cy="13" r="3.5" />
  </Svg>
);

// Runs — a list.
export const IconList = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </Svg>
);

// Plans — a clipboard.
export const IconClipboard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8" y="3" width="8" height="4" rx="1" />
    <path d="M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3" />
  </Svg>
);
