/* Ícones do protótipo (SVG inline, 16×16). */
type P = { size?: number };

export const IconExpand = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
  </svg>
);
export const IconLocate = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="4.5" />
    <path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" />
  </svg>
);
export const IconPlus = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M8 3v10M3 8h10" />
  </svg>
);
export const IconDrag = ({ size = 12 }: P) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
    <circle cx="5.5" cy="3.5" r="1.2" />
    <circle cx="10.5" cy="3.5" r="1.2" />
    <circle cx="5.5" cy="8" r="1.2" />
    <circle cx="10.5" cy="8" r="1.2" />
    <circle cx="5.5" cy="12.5" r="1.2" />
    <circle cx="10.5" cy="12.5" r="1.2" />
  </svg>
);
export const IconNote = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden="true"
  >
    <path d="M3 2.5h10v7l-4 4H3z" />
    <path d="M9 13.5v-4h4M5.5 5.5h5M5.5 8h3" />
  </svg>
);
export const IconIssue = ({ size = 14 }: P) => (
  <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="8" cy="8" r="1.8" fill="currentColor" />
  </svg>
);
export const IconMr = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden="true"
  >
    <circle cx="4" cy="3.5" r="1.8" />
    <circle cx="4" cy="12.5" r="1.8" />
    <circle cx="12" cy="12.5" r="1.8" />
    <path d="M4 5.3v5.4M12 10.7V7a3 3 0 0 0-3-3H7.5" />
  </svg>
);
export const IconRepo = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden="true"
  >
    <path d="M3 2.5h8.5A1.5 1.5 0 0 1 13 4v9.5H4.5A1.5 1.5 0 0 1 3 12z" />
    <path d="M3 12a1.5 1.5 0 0 1 1.5-1.5H13" />
  </svg>
);
export const IconAgent = ({ size = 14 }: P) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
    <path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" />
  </svg>
);
export const IconFit = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" />
  </svg>
);
export const IconSide = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
  >
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.5" />
    <path d="M6 2.75v10.5" />
  </svg>
);
export const IconTrash = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" />
  </svg>
);
export const IconHelp = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="6" />
    <path d="M6.4 6.3a1.7 1.7 0 0 1 3.2.7c0 1.2-1.6 1.4-1.6 2.5" />
    <circle cx="8" cy="11.6" r=".4" fill="currentColor" />
  </svg>
);
export const IconSearch = ({ size = 14 }: P) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden="true"
  >
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" strokeLinecap="round" />
  </svg>
);
export const IconZoomOut = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3M5 7h4" />
  </svg>
);
export const IconZoomIn = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3M5 7h4M7 5v4" />
  </svg>
);
export const IconNewNote = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden="true"
  >
    <path d="M3 2.5h10v7l-4 4H3z" />
    <path d="M9 13.5v-4h4" />
  </svg>
);
export const IconActivity = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M1.5 8h2.8l1.7-4.5 3 9L10.7 8h3.8" />
  </svg>
);
export const IconBolt = ({ size = 14 }: P) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" />
  </svg>
);
export const IconGear = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
  </svg>
);
export const IconPause = ({ size = 14 }: P) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
    <rect x="4" y="3" width="2.6" height="10" rx="1" />
    <rect x="9.4" y="3" width="2.6" height="10" rx="1" />
  </svg>
);
export const IconPlay = ({ size = 14 }: P) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
    <path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z" />
  </svg>
);
export const IconStop = ({ size = 14 }: P) => (
  <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
    <rect x="3.5" y="3.5" width="9" height="9" rx="2" />
  </svg>
);
export const IconDoc = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 1.75h5.25L12.5 5v9.25H4z" />
    <path d="M9 1.75V5.25h3.5M6 8.25h4.25M6 10.75h4.25" />
  </svg>
);
export const IconTheme = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 2.5v11a5.5 5.5 0 0 0 0-11z" fill="currentColor" />
  </svg>
);
export const IconChevron = ({ size = 12 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 6l4 4 4-4" />
  </svg>
);
export const IconCheck = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 8.5l3.2 3L13 4.5" />
  </svg>
);
export const IconPencil = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M10.5 2.5l3 3-8 8H2.5v-3z" />
  </svg>
);
export const IconGlobe = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14M8 2C6.2 3.7 5.4 5.7 5.4 8s.8 4.3 2.6 6" />
  </svg>
);
export const IconBack = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M13 8H3M7.5 3.5 3 8l4.5 4.5" />
  </svg>
);
export const IconForward = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 8h10M8.5 3.5 13 8l-4.5 4.5" />
  </svg>
);
export const IconReload = ({ size = 14 }: P) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" />
  </svg>
);
