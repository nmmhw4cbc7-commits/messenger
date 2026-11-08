// One consistent line icon set: 24px grid, 1.8 stroke, round joins.

import type { JSX } from 'preact';

type P = { size?: number; class?: string; stroke?: number };

function I({ size = 24, class: cls, stroke = 1.8, children }: P & { children: JSX.Element | JSX.Element[] }) {
  return (
    <svg class={cls} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const ChevronLeft = (p: P) => <I {...p} stroke={p.stroke ?? 2.2}><path d="M15 4.5 7.5 12l7.5 7.5" /></I>;
export const ChevronRight = (p: P) => <I {...p}><path d="m9.5 6 6 6-6 6" /></I>;
export const ChevronDown = (p: P) => <I {...p}><path d="m6 9.5 6 6 6-6" /></I>;
export const Compose = (p: P) => (
  <I {...p}>
    <path d="M11 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V13" />
    <path d="M17.6 3.9a1.9 1.9 0 0 1 2.7 2.7L12.5 14.4l-3.6.9.9-3.6Z" />
  </I>
);
export const Chats = (p: P) => (
  <I {...p}>
    <path d="M20.5 11.6c0 4.3-3.8 7.6-8.5 7.6-1.1 0-2.2-.2-3.2-.5L4 20l1.2-3.7c-1.1-1.3-1.7-2.9-1.7-4.7C3.5 7.3 7.3 4 12 4s8.5 3.3 8.5 7.6Z" />
  </I>
);
export const Gear = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 13.5a7.7 7.7 0 0 0 0-3l2-1.6-2-3.4-2.4.9a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.4A7.5 7.5 0 0 0 7 6.4l-2.4-.9-2 3.4 2 1.6a7.7 7.7 0 0 0 0 3l-2 1.6 2 3.4 2.4-.9a7.5 7.5 0 0 0 2.6 1.5l.4 2.4h4l.4-2.4a7.5 7.5 0 0 0 2.6-1.5l2.4.9 2-3.4Z" />
  </I>
);
export const Lock = (p: P) => (
  <I {...p}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7" />
  </I>
);
export const Shield = (p: P) => (
  <I {...p}>
    <path d="M12 3 5 5.8v5.4c0 4.4 3 8.3 7 9.8 4-1.5 7-5.4 7-9.8V5.8Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </I>
);
export const Camera = (p: P) => (
  <I {...p}>
    <path d="M4 8.5a2 2 0 0 1 2-2h1.8l1.5-2h5.4l1.5 2H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
    <circle cx="12" cy="12.8" r="3.4" />
  </I>
);
export const Person = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.8 20c.8-3.6 3.7-5.6 7.2-5.6s6.4 2 7.2 5.6" />
  </I>
);
export const People = (p: P) => (
  <I {...p}>
    <circle cx="9" cy="8.5" r="3.4" />
    <path d="M2.8 19.5c.6-3.2 3.1-5 6.2-5s5.6 1.8 6.2 5" />
    <path d="M15.5 5.3a3.4 3.4 0 0 1 0 6.4M17.6 14.8c1.9.6 3.2 2.2 3.6 4.7" />
  </I>
);
export const PersonAdd = (p: P) => (
  <I {...p}>
    <circle cx="10" cy="8.5" r="3.6" />
    <path d="M3.2 19.8c.7-3.4 3.4-5.3 6.8-5.3 1.6 0 3 .4 4.2 1.2M18.5 13v6M15.5 16h6" />
  </I>
);
export const Plus = (p: P) => <I {...p}><path d="M12 5v14M5 12h14" /></I>;
export const Check = (p: P) => <I {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></I>;
export const Clock = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </I>
);
export const Alert = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.8v5" />
    <path d="M12 16.2h.01" stroke-width="2.6" />
  </I>
);
export const ArrowUp = (p: P) => <I {...p} stroke={p.stroke ?? 2.4}><path d="M12 19V5.5M6 11.5l6-6 6 6" /></I>;
export const Search = (p: P) => (
  <I {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.4-4.4" />
  </I>
);
export const Close = (p: P) => <I {...p}><path d="M6 6l12 12M18 6 6 18" /></I>;
export const Trash = (p: P) => (
  <I {...p}>
    <path d="M4.5 6.5h15M9.5 6.5V4.8c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3v1.7M6.5 6.5l.8 12.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8l.8-12.2" />
  </I>
);
export const Block = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m6 6 12 12" />
  </I>
);
export const Key = (p: P) => (
  <I {...p}>
    <circle cx="8" cy="15.5" r="4" />
    <path d="m10.9 12.6 8.6-8.6M16.5 7l2.5 2.5M14 9.5l2 2" />
  </I>
);
export const Bell = (p: P) => (
  <I {...p}>
    <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15Z" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  </I>
);
export const Moon = (p: P) => <I {...p}><path d="M19.5 14.5A7.8 7.8 0 0 1 9.5 4.5a7.8 7.8 0 1 0 10 10Z" /></I>;
export const Info = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.2" />
    <path d="M12 7.8h.01" stroke-width="2.6" />
  </I>
);
export const Share = (p: P) => (
  <I {...p}>
    <path d="M12 3.5v11M7.5 8 12 3.5 16.5 8" />
    <path d="M8 11.5H6.5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2H16" />
  </I>
);
export const Copy = (p: P) => (
  <I {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2.2" />
    <path d="M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8" />
  </I>
);
export const Logout = (p: P) => (
  <I {...p}>
    <path d="M14 4.5H7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h7" />
    <path d="M10.5 12h10M17 8.5l3.5 3.5-3.5 3.5" />
  </I>
);
export const Contacts = (p: P) => (
  <I {...p}>
    <rect x="4.5" y="3.5" width="15" height="17" rx="2.5" />
    <circle cx="12" cy="10" r="2.6" />
    <path d="M8 16.5c.6-1.9 2.1-2.9 4-2.9s3.4 1 4 2.9" />
  </I>
);
export const Pencil = (p: P) => (
  <I {...p}>
    <path d="M16.3 4.2a2.2 2.2 0 0 1 3.1 3.1L8.2 18.5 4 19.9l1.4-4.2Z" />
  </I>
);
export const Exit = (p: P) => (
  <I {...p}>
    <path d="M10 4.5h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-7" />
    <path d="M14 12H3.5M7 8.5 3.5 12 7 15.5" />
  </I>
);
export const Star = (p: P) => <I {...p}><path d="m12 4 2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.8 2.7 1-5.4-4-3.7 5.5-.6Z" /></I>;
export const CheckDouble = (p: P) => (
  <I {...p}>
    <path d="m2.5 12.5 4.5 4.5 9-9.5" />
    <path d="m12 16.2.8.8 9-9.5" />
  </I>
);
export const Reply = (p: P) => (
  <I {...p}>
    <path d="M9.5 6.5 4 12l5.5 5.5" />
    <path d="M4.5 12H14a6 6 0 0 1 6 6v.5" />
  </I>
);
export const Palette = (p: P) => (
  <I {...p}>
    <path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1-1.6-1-2.6 0-.9.7-1.5 1.6-1.5h2.1a4 4 0 0 0 4-4c0-4-3.8-7.2-8.5-7.2Z" />
    <circle cx="7.8" cy="11.5" r="1" />
    <circle cx="10.5" cy="7.6" r="1" />
    <circle cx="15" cy="7.8" r="1" />
  </I>
);
export const Pin = (p: P) => (
  <I {...p}>
    <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z" />
    <path d="M12 14v6" />
  </I>
);
export const Timer = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="13" r="7.5" stroke-dasharray="3 2.2" />
    <path d="M12 9v4l2.5 2M10 3h4" />
  </I>
);
export const Vibrate = (p: P) => (
  <I {...p}>
    <rect x="8" y="4" width="8" height="16" rx="2" />
    <path d="M4.5 8v8M19.5 8v8M2 10v4M22 10v4" />
  </I>
);
export const Cloud = (p: P) => (
  <I {...p}>
    <path d="M7 18.5h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.1 9.6 4.5 4.5 0 0 0 7 18.5Z" />
    <path d="M12 15.5v-5M9.8 12.6 12 10.4l2.2 2.2" />
  </I>
);
export const Globe = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5Z" />
  </I>
);
