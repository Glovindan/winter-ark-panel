import { addDays, arcTotalDays, type ArcRange, type DateStr } from './dates';
import {
  dailyRing,
  overall,
  workoutRing,
  workoutWeeks,
  type Rings,
  type StreakInfo,
  type WorkoutWeek,
} from './rings';

/** Всё, что нужно знать об участнике для расчётов прогресса. */
export interface History {
  perWeek: number;
  /** даты, когда отмечены обязательные пункты */
  nutrition: ReadonlySet<DateStr>;
  sleep: ReadonlySet<DateStr>;
  workout: ReadonlySet<DateStr>;
  /** даты паузы («болею», «в отъезде») */
  paused: ReadonlySet<DateStr>;
}

export const MAX_PAUSE_REQUEST_DAYS = 14;
export const MAX_PAUSE_TOTAL_DAYS = 21;

const FIRST_FREEZES = 1;
const MAX_FREEZES = 2;
const ACTIVE_DAYS_PER_FREEZE = 14;

export const ringsOf = (arc: ArcRange, today: DateStr, h: History): Rings => ({
  nutrition: dailyRing(arc, today, h.nutrition, h.paused),
  workout: workoutRing(arc, today, h.workout, h.perWeek, h.paused),
  sleep: dailyRing(arc, today, h.sleep, h.paused),
});

/** День «в строю»: отмечены и питание, и сон. */
export const isGoodDay = (h: History, d: DateStr): boolean => h.nutrition.has(d) && h.sleep.has(d);

/**
 * Серия считается по дням «в строю». Дни паузы пропускаются. Пропущенный день не обрывает серию,
 * пока есть заморозка: одна в начале и ещё по одной за каждые 14 активных дней (максимум две).
 * Сегодняшний день ещё открыт: если он выполнен, серия растёт, если нет, ничего не ломается.
 */
export function computeStreak(arc: ArcRange, today: DateStr, h: History): StreakInfo {
  let current = 0;
  let best = 0;
  let freezes = FIRST_FREEZES;
  let used = 0;
  let activeDays = 0;
  const last = addDays(today, -1) < arc.endDate ? addDays(today, -1) : arc.endDate;

  for (let d = arc.startDate; d <= last; d = addDays(d, 1)) {
    if (h.paused.has(d)) continue;
    activeDays++;
    if (activeDays % ACTIVE_DAYS_PER_FREEZE === 0) freezes = Math.min(freezes + 1, MAX_FREEZES);
    if (isGoodDay(h, d)) {
      current++;
      best = Math.max(best, current);
    } else if (freezes > 0) {
      freezes--;
      used++;
    } else {
      current = 0;
    }
  }

  if (today >= arc.startDate && today <= arc.endDate && !h.paused.has(today) && isGoodDay(h, today)) {
    current++;
    best = Math.max(best, current);
  }
  return { current, best, freezesLeft: freezes, freezesUsed: used };
}

export interface WeekStats {
  weekStart: DateStr;
  activeDays: number;
  nutritionDone: number;
  sleepDone: number;
  workoutDone: number;
  workoutTarget: number;
  closed: boolean;
  /** все активные дни «в строю» и цель по тренировкам выполнена */
  perfect: boolean;
  /** доля выполненных слотов за неделю, null если слотов нет (вся неделя на паузе) */
  score: number | null;
}

export function weekStatsOf(h: History, w: WorkoutWeek): WeekStats {
  let nutritionDone = 0;
  let sleepDone = 0;
  for (let d = w.from; d <= w.to; d = addDays(d, 1)) {
    if (h.paused.has(d)) continue;
    if (h.nutrition.has(d)) nutritionDone++;
    if (h.sleep.has(d)) sleepDone++;
  }
  const slots = 2 * w.activeDays + w.target;
  return {
    weekStart: w.weekStart,
    activeDays: w.activeDays,
    nutritionDone,
    sleepDone,
    workoutDone: w.done,
    workoutTarget: w.target,
    closed: w.closed,
    perfect: w.closed && w.activeDays > 0 && nutritionDone === w.activeDays && sleepDone === w.activeDays && w.done >= w.target,
    score: slots > 0 ? (nutritionDone + sleepDone + w.done) / slots : null,
  };
}

export const weekStatsList = (arc: ArcRange, today: DateStr, h: History): WeekStats[] =>
  workoutWeeks(arc, today, h.workout, h.perWeek, h.paused).map((w) => weekStatsOf(h, w));

/** Самая длинная цепочка идеальных недель подряд; недели целиком на паузе цепочку не рвут. */
export function perfectWeekRuns(weeks: WeekStats[]): { count: number; bestRun: number } {
  let count = 0;
  let run = 0;
  let bestRun = 0;
  for (const w of weeks) {
    if (!w.closed || w.activeDays === 0) continue;
    if (w.perfect) {
      count++;
      run++;
      bestRun = Math.max(bestRun, run);
    } else run = 0;
  }
  return { count, bestRun };
}

/** После серии из 3+ пропущенных дней — 5 дней «в строю» подряд. */
export function hasComeback(arc: ArcRange, today: DateStr, h: History): boolean {
  let gap = 0;
  let armed = false;
  let run = 0;
  for (let d = arc.startDate; d <= arc.endDate && d <= today; d = addDays(d, 1)) {
    if (h.paused.has(d)) continue;
    if (isGoodDay(h, d)) {
      if (gap >= 3) {
        armed = true;
        run = 0;
      }
      gap = 0;
      if (armed && ++run >= 5) return true;
    } else if (d < today) {
      gap++;
      armed = false;
      run = 0;
    }
  }
  return false;
}

export interface AchievementDef {
  code: string;
  icon: string;
  title: string;
  description: string;
  /** скрытая: до открытия показывается как «???» */
  hidden?: boolean;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { code: 'streak-3', icon: '🔥', title: 'Разгон', description: '3 дня подряд с питанием и сном' },
  { code: 'streak-7', icon: '🔥', title: 'Неделя в строю', description: '7 дней подряд с питанием и сном' },
  { code: 'streak-14', icon: '🔥', title: 'Две недели', description: '14 дней подряд с питанием и сном' },
  { code: 'streak-30', icon: '🏔️', title: 'Месяц стали', description: '30 дней подряд с питанием и сном' },
  { code: 'streak-60', icon: '🧊', title: 'Несгибаемый', description: '60 дней подряд с питанием и сном' },
  { code: 'workouts-10', icon: '💪', title: 'Первая десятка', description: '10 тренировок за арку' },
  { code: 'workouts-50', icon: '🏋️', title: 'Полсотни', description: '50 тренировок за арку' },
  { code: 'workouts-100', icon: '🥇', title: 'Сотня', description: '100 тренировок за арку' },
  { code: 'nutrition-50', icon: '🥗', title: 'Пятьдесят в норме', description: '50 дней уложился в КБЖУ' },
  { code: 'nutrition-100', icon: '🍎', title: 'Сто в норме', description: '100 дней уложился в КБЖУ' },
  { code: 'sleep-50', icon: '😴', title: 'Сон — это сила', description: '50 ночей с нормой сна' },
  { code: 'perfect-week', icon: '⭐', title: 'Идеальная неделя', description: 'Все дни в строю и цель по тренировкам выполнена' },
  { code: 'perfect-weeks-4', icon: '🌟', title: 'Идеальный месяц', description: '4 идеальные недели подряд' },
  { code: 'comeback', icon: '🔄', title: 'Камбэк', description: 'После 3 и более пропущенных дней — 5 дней в строю подряд' },
  { code: 'newyear', icon: '🎄', title: 'Новый год в строю', description: 'Питание и сон отмечены 31 декабря' },
  { code: 'halfway', icon: '🧭', title: 'Экватор', description: 'Прошла половина арки, а ты держишься: выполнено не меньше 60% слотов' },
  { code: 'finisher', icon: '🏁', title: 'Финишёр', description: 'Дошёл до конца арки с 80% выполненных слотов', hidden: true },
  { code: 'all-in-7', icon: '🎯', title: 'Всё и сразу', description: '7 дней, когда в один день выполнены питание, сон и тренировка', hidden: true },
];

export type HabitDayMark = 'done' | 'miss' | 'pause' | 'open' | 'none';

export interface HabitStat {
  /** сколько дней пункт выполнен */
  done: number;
  /** подряд до сегодняшнего дня (дни паузы пропускаются, сегодняшний ещё открыт) */
  streak: number;
  /** последние 7 дней от старых к свежим */
  last7: HabitDayMark[];
}

/**
 * Итоги по личному пункту из списка дней (от свежих к старым, как отдаёт сервер).
 * Дата создания пункта не хранится, поэтому дни раньше первой отметки считаются «ничего»: пункта могло ещё не быть.
 */
export function habitStat(
  days: { date: DateStr; done: number[] }[],
  habitId: number,
  paused: ReadonlySet<DateStr>,
  today: DateStr,
): HabitStat {
  const doneDates = days.filter((d) => d.done.includes(habitId)).map((d) => d.date);
  const firstDone = doneDates.reduce<DateStr | null>((min, d) => (min === null || d < min ? d : min), null);
  const isDone = (d: DateStr) => doneDates.includes(d);

  let streak = 0;
  for (const { date } of days) {
    if (paused.has(date)) continue;
    if (isDone(date)) streak++;
    else if (date >= today) continue; // сегодняшний день ещё открыт
    else break;
  }

  const last7 = days
    .slice(0, 7)
    .map(({ date }): HabitDayMark => {
      if (isDone(date)) return 'done';
      if (paused.has(date)) return 'pause';
      if (date >= today) return 'open';
      return firstDone !== null && date > firstDone ? 'miss' : 'none';
    })
    .reverse();

  return { done: doneDates.length, streak, last7 };
}

/** Ачивка для показа участнику: unlockedAt = null, если ещё не открыта */
export interface AchievementView extends AchievementDef {
  unlockedAt: string | null;
}

export const achievementByCode =(code: string): AchievementDef | undefined =>
  ACHIEVEMENTS.find((a) => a.code === code);

const keptRatio = (rings: Rings): number => {
  const o = overall(rings);
  const closed = o.done + o.skipped;
  return closed > 0 ? o.done / closed : 0;
};

/** Коды ачивок, условия которых выполнены на сегодня. Открытые ранее ачивки не отзываются (это решает вызывающий). */
export function evaluateAchievements(arc: ArcRange, today: DateStr, h: History): Set<string> {
  const earned = new Set<string>();
  const inArc = (d: DateStr) => d >= arc.startDate && d <= arc.endDate;
  const count = (s: ReadonlySet<DateStr>) => [...s].filter((d) => inArc(d) && !h.paused.has(d)).length;

  const streak = computeStreak(arc, today, h);
  for (const n of [3, 7, 14, 30, 60]) if (streak.best >= n) earned.add(`streak-${n}`);

  for (const n of [10, 50, 100]) if (count(h.workout) >= n) earned.add(`workouts-${n}`);
  for (const n of [50, 100]) if (count(h.nutrition) >= n) earned.add(`nutrition-${n}`);
  if (count(h.sleep) >= 50) earned.add('sleep-50');

  const runs = perfectWeekRuns(weekStatsList(arc, today, h));
  if (runs.count >= 1) earned.add('perfect-week');
  if (runs.bestRun >= 4) earned.add('perfect-weeks-4');

  if (hasComeback(arc, today, h)) earned.add('comeback');

  for (let d = arc.startDate; d <= arc.endDate && d <= today; d = addDays(d, 1)) {
    if (d.endsWith('-12-31') && !h.paused.has(d) && isGoodDay(h, d)) earned.add('newyear');
  }

  const rings = ringsOf(arc, today, h);
  const total = arcTotalDays(arc);
  const elapsed = today > arc.endDate ? total : daysBetween(arc.startDate, today);
  if (elapsed * 2 >= total && keptRatio(rings) >= 0.6) earned.add('halfway');
  if (today > arc.endDate && keptRatio(rings) >= 0.8) earned.add('finisher');

  let allIn = 0;
  for (const d of h.workout) if (inArc(d) && !h.paused.has(d) && isGoodDay(h, d)) allIn++;
  if (allIn >= 7) earned.add('all-in-7');

  return earned;
}

/** Число прошедших дней арки до сегодняшнего (не включая его), от 0 до длины арки. */
function daysBetween(from: DateStr, to: DateStr): number {
  let n = 0;
  for (let d = from; d < to; d = addDays(d, 1)) n++;
  return n;
}
