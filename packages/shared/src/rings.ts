import { addDays, diffDays, weekStart, type ArcRange, type DateStr } from './dates';
import type { HabitType } from './habits';

export type RingKind = 'nutrition' | 'workout' | 'sleep';
export const RING_KINDS: RingKind[] = ['nutrition', 'workout', 'sleep'];

/** done + skipped + (будущие слоты) = total */
export interface RingStat {
  done: number;
  skipped: number;
  total: number;
}

const NO_DATES: ReadonlySet<DateStr> = new Set();

/**
 * Питание и сон: каждый день арки — один слот; дни паузы слотами не считаются.
 * День без отметки считается пропущенным, как только он строго раньше «сегодня».
 */
export function dailyRing(
  arc: ArcRange,
  today: DateStr,
  doneDates: Iterable<DateStr>,
  paused: ReadonlySet<DateStr> = NO_DATES,
): RingStat {
  const done = new Set(doneDates);
  const stat: RingStat = { done: 0, skipped: 0, total: 0 };
  for (let d = arc.startDate; d <= arc.endDate; d = addDays(d, 1)) {
    if (paused.has(d)) continue;
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
  /** дней недели внутри арки, не попавших на паузу */
  activeDays: number;
  /** неделя закончилась, недовыполнение уже считается пропуском */
  closed: boolean;
}

/**
 * Тренировки считаются по неделям (пн–вс). Цель недели пропорциональна числу активных дней:
 * неполные недели на краях арки и дни паузы уменьшают её.
 */
export function workoutWeeks(
  arc: ArcRange,
  today: DateStr,
  doneDates: Iterable<DateStr>,
  perWeek: number,
  paused: ReadonlySet<DateStr> = NO_DATES,
): WorkoutWeek[] {
  const dates = [...doneDates];
  const weeks: WorkoutWeek[] = [];
  for (let ws = weekStart(arc.startDate); ws <= arc.endDate; ws = addDays(ws, 7)) {
    const from = ws < arc.startDate ? arc.startDate : ws;
    const we = addDays(ws, 6);
    const to = we > arc.endDate ? arc.endDate : we;
    let activeDays = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) if (!paused.has(d)) activeDays++;
    const target = activeDays === 7 ? perWeek : Math.round((perWeek * activeDays) / 7);
    const count = dates.filter((d) => d >= from && d <= to && !paused.has(d)).length;
    weeks.push({ weekStart: ws, from, to, target, done: Math.min(count, target), activeDays, closed: to < today });
  }
  return weeks;
}

export function workoutRing(
  arc: ArcRange,
  today: DateStr,
  doneDates: Iterable<DateStr>,
  perWeek: number,
  paused: ReadonlySet<DateStr> = NO_DATES,
): RingStat {
  const stat: RingStat = { done: 0, skipped: 0, total: 0 };
  for (const w of workoutWeeks(arc, today, doneDates, perWeek, paused)) {
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

/** Серия дней, когда отмечены питание и сон (дни паузы не считаются) */
export interface StreakInfo {
  current: number;
  best: number;
  freezesLeft: number;
  freezesUsed: number;
}

export interface UnlockedAchievement {
  code: string;
  unlockedAt: string;
}

export interface DashboardUser {
  id: number;
  name: string;
  avatarUrl: string | null;
  rings: Rings;
  streak: number;
  /** коды последних открытых ачивок (до трёх) */
  badges: string[];
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
  type: HabitType;
  target: number | null;
  createdAt: DateStr | null;
}

export interface UserDetailResponse {
  user: { id: number; name: string; avatarUrl: string | null; workoutsPerWeek: number };
  today: DateStr;
  startDate: DateStr;
  endDate: DateStr;
  rings: Rings;
  streak: StreakInfo;
  achievements: UnlockedAchievement[];
  /** даты паузы внутри арки */
  paused: DateStr[];
  habits: DetailHabit[];
  weeks: WorkoutWeek[];
  /** от свежих к старым, от старта арки до сегодня; done — id пунктов, выполненных в этот день */
  days: { date: DateStr; done: number[] }[];
}
