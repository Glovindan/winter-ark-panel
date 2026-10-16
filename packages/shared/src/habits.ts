import { addDays, arcTotalDays, diffDays, weekStart, type ArcRange, type DateStr } from './dates';

/** Тип личного пункта: каждый день, N раз в неделю или общее число раз за арку. */
export type HabitType = 'daily' | 'weekly' | 'arc_total';

export const HABIT_TYPES: { value: HabitType; label: string }[] = [
  { value: 'daily', label: 'Каждый день' },
  { value: 'weekly', label: 'N раз в неделю' },
  { value: 'arc_total', label: 'Цель на арку' },
];

export const MAX_WEEKLY_TARGET = 7;
export const MAX_ARC_TARGET = 365;

/** Допустимое сочетание типа и цели: у ежедневного цели нет, у недельного 1–7, у арочного 1–365. */
export function isValidHabitSpec(type: unknown, target: unknown): boolean {
  if (type === 'daily') return target === null || target === undefined;
  if (type === 'weekly') return Number.isInteger(target) && (target as number) >= 1 && (target as number) <= MAX_WEEKLY_TARGET;
  if (type === 'arc_total') return Number.isInteger(target) && (target as number) >= 1 && (target as number) <= MAX_ARC_TARGET;
  return false;
}

export interface HabitSpec {
  type: HabitType;
  target: number | null;
  /** день создания пункта (по времени арки); null у пунктов, созданных до появления типов */
  createdAt: DateStr | null;
}

export type HabitProgress =
  | { kind: 'week'; done: number; target: number }
  | { kind: 'arc'; done: number; target: number };

export type WeekState = 'met' | 'miss' | 'open' | 'skip';

export interface HabitWeek {
  weekStart: DateStr;
  from: DateStr;
  to: DateStr;
  /** дней недели внутри арки и после создания пункта, не попавших на паузу */
  activeDays: number;
  target: number;
  /** сколько раз отмечено; сверх нормы копится */
  done: number;
  closed: boolean;
  /** met — норма выполнена, miss — неделя закончилась без нормы, open — идёт, skip — слотов нет (пауза или неполная неделя) */
  state: WeekState;
}

const NO_DATES: ReadonlySet<DateStr> = new Set();

const minDate = (dates: Iterable<DateStr>): DateStr | null => {
  let min: DateStr | null = null;
  for (const d of dates) if (min === null || d < min) min = d;
  return min;
};

/** С какого дня пункт «в игре»: со дня создания, но не раньше старта арки и не позже первой отметки. */
function activeSince(arc: ArcRange, spec: HabitSpec, done: ReadonlySet<DateStr>): DateStr {
  const first = minDate(done);
  const created = spec.createdAt ?? arc.startDate;
  const since = first !== null && first < created ? first : created;
  return since < arc.startDate ? arc.startDate : since;
}

/**
 * Недели для пункта «N раз в неделю», от первой до текущей. Цель недели пропорциональна числу активных дней:
 * неполные недели на краях арки, в неделю создания пункта и дни паузы уменьшают её, как у тренировок.
 */
export function habitWeeks(
  arc: ArcRange,
  today: DateStr,
  spec: HabitSpec,
  done: ReadonlySet<DateStr>,
  paused: ReadonlySet<DateStr> = NO_DATES,
): HabitWeek[] {
  if (spec.type !== 'weekly' || !spec.target) return [];
  const since = activeSince(arc, spec, done);
  const weeks: HabitWeek[] = [];
  for (let ws = weekStart(since); ws <= today && ws <= arc.endDate; ws = addDays(ws, 7)) {
    const from = ws < since ? since : ws;
    const to = addDays(ws, 6) > arc.endDate ? arc.endDate : addDays(ws, 6);
    let activeDays = 0;
    let count = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (paused.has(d)) continue;
      activeDays++;
      if (done.has(d)) count++;
    }
    const target = activeDays === 7 ? spec.target : Math.round((spec.target * activeDays) / 7);
    const closed = to < today;
    const state: WeekState = target === 0 ? 'skip' : count >= target ? 'met' : closed ? 'miss' : 'open';
    weeks.push({ weekStart: ws, from, to, activeDays, target, done: count, closed, state });
  }
  return weeks;
}

export interface WeeklyStat {
  /** всего отметок за всё время */
  done: number;
  /** недель с выполненной нормой */
  weeksMet: number;
  /** недель с выполненной нормой подряд к сегодняшнему дню; идущая неделя не обрывает, пока она не закрыта */
  streak: number;
  /** последние 4 недели от старых к свежим */
  last4: HabitWeek[];
}

export function weeklyStat(
  arc: ArcRange,
  today: DateStr,
  spec: HabitSpec,
  done: ReadonlySet<DateStr>,
  paused: ReadonlySet<DateStr> = NO_DATES,
): WeeklyStat {
  const weeks = habitWeeks(arc, today, spec, done, paused);
  let streak = 0;
  for (let i = weeks.length - 1; i >= 0; i--) {
    const w = weeks[i]!;
    if (w.state === 'skip' || w.state === 'open') continue;
    if (w.state === 'met') streak++;
    else break;
  }
  return {
    done: [...done].filter((d) => d >= arc.startDate && d <= arc.endDate).length,
    weeksMet: weeks.filter((w) => w.state === 'met').length,
    streak,
    last4: weeks.slice(-4),
  };
}

export interface ArcStat {
  done: number;
  target: number;
  /** доля цели, может быть больше 1: сверх нормы копится */
  ratio: number;
  /** по графику: сделано не меньше, чем положено к сегодняшнему дню при равномерном темпе */
  onTrack: boolean;
}

export function arcStat(arc: ArcRange, today: DateStr, target: number, done: ReadonlySet<DateStr>): ArcStat {
  const count = [...done].filter((d) => d >= arc.startDate && d <= arc.endDate).length;
  const total = arcTotalDays(arc);
  const elapsed = Math.min(total, Math.max(0, diffDays(today, arc.startDate) + 1));
  return { done: count, target, ratio: count / target, onTrack: count >= Math.floor((target * elapsed) / total) };
}

/** Прогресс пункта на дату `date`: неделя, в которую она попадает, или всего за арку. Для ежедневного null. */
export function habitProgress(
  arc: ArcRange,
  today: DateStr,
  spec: HabitSpec,
  done: ReadonlySet<DateStr>,
  paused: ReadonlySet<DateStr>,
  date: DateStr,
): HabitProgress | null {
  if (spec.type === 'arc_total' && spec.target) {
    return { kind: 'arc', done: arcStat(arc, today, spec.target, done).done, target: spec.target };
  }
  if (spec.type === 'weekly' && spec.target) {
    const week = habitWeeks(arc, today, spec, done, paused).find((w) => date >= w.from && date <= w.to);
    return { kind: 'week', done: week?.done ?? 0, target: week?.target ?? spec.target };
  }
  return null;
}
