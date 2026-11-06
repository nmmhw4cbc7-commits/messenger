const locale = navigator.language || 'en';
const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' });
const shortWeekday = new Intl.DateTimeFormat(locale, { weekday: 'short' });
const date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
const fullDate = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' });
const dayMonth = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' });

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const daysAgo = (t: number) => Math.round((startOfDay(Date.now()) - startOfDay(t)) / 86400_000);

export const formatTime = (t: number) => time.format(t);

/** Chat list: time today, weekday this week, date otherwise. */
export function formatListTime(t: number) {
  const d = daysAgo(t);
  if (d <= 0) return time.format(t);
  if (d === 1) return 'Yesterday';
  if (d < 7) return shortWeekday.format(t);
  return date.format(t);
}

/** Day separators inside a chat. */
export function formatDay(t: number) {
  const d = daysAgo(t);
  if (d <= 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 7) return weekday.format(t);
  if (new Date(t).getFullYear() === new Date().getFullYear()) return dayMonth.format(t);
  return fullDate.format(t);
}

export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);

export function initials(name: string) {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const first = [...parts[0]][0] ?? '';
  const last = parts.length > 1 ? [...parts[parts.length - 1]][0] ?? '' : '';
  return (first + last).toUpperCase();
}
