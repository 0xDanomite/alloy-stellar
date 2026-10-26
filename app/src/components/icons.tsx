import type { ReactNode } from "react";

function Icon({ children, className = "size-[18px]" }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const ArrowRight = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);

export const ArrowLeft = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Icon>
);

export const Layers = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 13 9 5 9-5" />
  </Icon>
);

export const Scale = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M12 4v16M7 20h10M5 7h14" />
    <path d="m5 7-3 6a3 3 0 0 0 6 0L5 7ZM19 7l-3 6a3 3 0 0 0 6 0l-3-6Z" />
  </Icon>
);

export const Shield = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);

export const Banknote = (p: { className?: string }) => (
  <Icon {...p}>
    <rect x="3" y="6" width="18" height="12" rx="2.5" />
    <circle cx="12" cy="12" r="2.5" />
  </Icon>
);

export const Grid = (p: { className?: string }) => (
  <Icon {...p}>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
  </Icon>
);

export const Lock = (p: { className?: string }) => (
  <Icon {...p}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5M12 14.5v2" />
  </Icon>
);

export const Plus = (p: { className?: string }) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 8.5v7M8.5 12h7" />
  </Icon>
);

export const Users = (p: { className?: string }) => (
  <Icon {...p}>
    <circle cx="9" cy="8.5" r="3.5" />
    <path d="M3 20c.6-3.4 3-5.5 6-5.5s5.4 2.1 6 5.5M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.8c1.7.7 2.8 2.5 3 5.2" />
  </Icon>
);

export const Swap = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5" />
  </Icon>
);

export const Bell = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5l1.5-2Z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </Icon>
);

export const Percent = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M19 5 5 19" />
    <circle cx="7" cy="7" r="2.5" />
    <circle cx="17" cy="17" r="2.5" />
  </Icon>
);

export const Eye = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const Wallet = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" />
    <rect x="4" y="8" width="16" height="11" rx="2.5" />
    <path d="M16 13.5h1.5" />
  </Icon>
);

export const Coins = (p: { className?: string }) => (
  <Icon {...p}>
    <ellipse cx="9" cy="7" rx="5.5" ry="2.5" />
    <path d="M3.5 7v4c0 1.4 2.5 2.5 5.5 2.5M3.5 11v4c0 1.4 2.5 2.5 5.5 2.5" />
    <ellipse cx="15" cy="13" rx="5.5" ry="2.5" />
    <path d="M9.5 13v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-4" />
  </Icon>
);

export const Clock = (p: { className?: string }) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);

export const Exit = (p: { className?: string }) => (
  <Icon {...p}>
    <path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14" />
    <path d="M10 8l-4 4 4 4M6 12h10" />
  </Icon>
);

export const Key = (p: { className?: string }) => (
  <Icon {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2" />
  </Icon>
);
