/** Даты арки хранятся строками YYYY-MM-DD в часовом поясе арки; арифметика ведётся в UTC, чтобы не зависеть от DST. */
export type DateStr = string;

const DAY_MS = 86_400_000;
const toMs = (d: DateStr) => Date.parse(`${d}T00:00:00Z`);
const fmt = (ms: number): DateStr => new Date(ms).toISOString().slice(0, 10);

export const isDateStr = (s: unknown): s is DateStr =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toMs(s)) && fmt(toMs(s)) === s;

export const addDays = (d: DateStr, n: number): DateStr => fmt(toMs(d) + n * DAY_MS);

export const diffDays = (a: DateStr, b: DateStr): number => Math.round((toMs(a) - toMs(b)) / DAY_MS);

/** Понедельник недели, в которую попадает дата. */
export const weekStart = (d: DateStr): DateStr => addDays(d, -((new Date(toMs(d)).getUTCDay() + 6) % 7));

export const todayInTz = (tz: string, now: Date = new Date()): DateStr =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export interface ArcRange {
  startDate: DateStr;
  endDate: DateStr;
}

export const arcTotalDays = (arc: ArcRange): number => diffDays(arc.endDate, arc.startDate) + 1;

/** Отметки можно ставить только за сегодня и вчера, и только внутри арки. */
export const isEditable = (date: DateStr, today: DateStr, arc: ArcRange): boolean =>
  date >= arc.startDate && date <= arc.endDate && (date === today || date === addDays(today, -1));
