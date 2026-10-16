import { addDays, diffDays, weekStart, type ArcRange, type DateStr } from './dates';

export type RingKind = 'nutrition' | 'workout' | 'sleep';
export const RING_KINDS: RingKind[] = ['nutrition', 'workout', 'sleep'];

/** done + skipped + (будущие слоты) = total */
export interface RingStat {
  done: number;
  skipped: number;
  total: number;
}

/**
 * Питание и сон: каждый день арки — один слот.
 * День без отметки считается пропущенным, как только он строго раньше «сегодня».
 */
export function dailyRing(arc: ArcRange, today: DateStr, doneDates: Iterable<DateStr>): RingStat {
  const done = new Set(doneDates);
  const stat: RingStat = { done: 0, skipped: 0, total: 0 };
  for (let d = arc.startDate; d <= arc.endDate; d = addDays(d, 1)) {
    stat.total++;
    if (done.has(d)) stat.done++;
    else if (d < today) stat.skipped++;
  }
  return stat;
}

export interface WorkoutWeek {
  /** понедельник недели */
  weekStart: DateStr;
  from: DateStr;
  to: DateStr;
  target: number;
  done: number;
  /** неделя закончилась, недовыполнение уже считается пропуском */
  closed: boolean;
}

/** Тренировки считаются по неделям (пн–вс); неполные недели на краях арки получают пропорциональную цель. */
export function workoutWeeks(
  arc: ArcRange,
  today: DateStr,
  doneDates: Iterable<DateStr>,
  perWeek: number,
): WorkoutWeek[] {
  const dates = [...doneDates];
  const weeks: WorkoutWeek[] = [];
  for (let ws = weekStart(arc.startDate); ws <= arc.endDate; ws = addDays(ws, 7)) {
    const from = ws < arc.startDate ? arc.startDate : ws;
    const we = addDays(ws, 6);
    const to = we > arc.endDate ? arc.endDate : we;
    const days = diffDays(to, from) + 1;
    const target = days === 7 ? perWeek : Math.round((perWeek * days) / 7);
    const count = dates.filter((d) => d >= from && d <= to).length;
    weeks.push({ weekStart: ws, from, to, target, done: Math.min(count, target), closed: to < today });
  }
  return weeks;
}

export function workoutRing(
  arc: ArcRange,
  today: DateStr,
  doneDates: Iterable<DateStr>,
  perWeek: number,
): RingStat {
  const stat: RingStat = { done: 0, skipped: 0, total: 0 };
  for (const w of workoutWeeks(arc, today, doneDates, perWeek)) {
    stat.total += w.target;
    stat.done += w.done;
    if (w.closed) stat.skipped += w.target - w.done;
  }
  return stat;
}

export type Rings = Record<RingKind, RingStat>;

export function overall(rings: Rings): { done: number; skipped: number; total: number } {
  return RING_KINDS.reduce(
    (acc, k) => ({
      done: acc.done + rings[k].done,
      skipped: acc.skipped + rings[k].skipped,
      total: acc.total + rings[k].total,
    }),
    { done: 0, skipped: 0, total: 0 },
  );
}

export interface DashboardUser {
  id: number;
  name: string;
  avatarUrl: string | null;
  rings: Rings;
}

export interface DashboardResponse {
  today: DateStr;
  startDate: DateStr;
  endDate: DateStr;
  users: DashboardUser[];
}

export interface DetailHabit {
  id: number;
  kind: 'nutrition' | 'workout' | 'sleep' | 'custom';
  title: string;
}

export interface UserDetailResponse {
  user: { id: number; name: string; avatarUrl: string | null; workoutsPerWeek: number };
  today: DateStr;
  rings: Rings;
  habits: DetailHabit[];
  weeks: WorkoutWeek[];
  /** от свежих к старым, от старта арки до сегодня; done — id пунктов, выполненных в этот день */
  days: { date: DateStr; done: number[] }[];
}
