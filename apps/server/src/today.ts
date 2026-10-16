import {
  addDays,
  arcTotalDays,
  computeStreak,
  diffDays,
  habitProgress,
  isEditable,
  todayInTz,
  workoutWeeks,
  type ArcRange,
  type DateStr,
  type HabitType,
  type TodayResponse,
  type UserProfile,
} from '@ark/shared';
import type { Config } from './config';
import type { Db } from './db';
import { loadCustomDone, loadHistories } from './history';
import { pauseDaysLeft, pauseEndsOn } from './pause';

export interface Arc extends ArcRange {
  tz: string;
}

export function getArc(db: Db): Arc {
  const r = db.prepare('SELECT start_date, end_date, tz FROM arc WHERE id = 1').get() as {
    start_date: string; end_date: string; tz: string;
  };
  return { startDate: r.start_date, endDate: r.end_date, tz: r.tz };
}

export function currentDate(config: Config, arc: Arc): DateStr {
  return config.devToday ?? todayInTz(arc.tz);
}

interface HabitRow { id: number; kind: TodayResponse['habits'][number]['kind']; title: string }

export function visibleHabit(db: Db, habitId: number, userId: number): HabitRow | undefined {
  return db
    .prepare('SELECT id, kind, title FROM habit WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)')
    .get(habitId, userId) as HabitRow | undefined;
}

export function isDone(db: Db, userId: number, habitId: number, date: DateStr): boolean {
  return !!db
    .prepare("SELECT 1 FROM checkin WHERE user_id = ? AND habit_id = ? AND date = ? AND status = 'done'")
    .get(userId, habitId, date);
}

/** Ставит или снимает отметку. Права и окно правки проверяет вызывающий. */
export function setCheckin(db: Db, userId: number, habitId: number, date: DateStr, done: boolean): void {
  if (done) {
    db.prepare(
      `INSERT INTO checkin (user_id, habit_id, date, status) VALUES (?, ?, ?, 'done')
       ON CONFLICT(user_id, habit_id, date) DO UPDATE SET status = 'done', updated_at = datetime('now')`,
    ).run(userId, habitId, date);
  } else {
    db.prepare('DELETE FROM checkin WHERE user_id = ? AND habit_id = ? AND date = ?').run(userId, habitId, date);
  }
}

interface FullHabitRow extends HabitRow { type: HabitType; target: number | null; created_at: DateStr | null }

export function buildToday(db: Db, user: UserProfile, date: DateStr, today: DateStr, arc: Arc): TodayResponse {
  const habits = db
    .prepare(
      `SELECT id, kind, title, type, target, created_at FROM habit WHERE owner_id IS NULL OR owner_id = ?
       ORDER BY CASE kind WHEN 'nutrition' THEN 1 WHEN 'workout' THEN 2 WHEN 'sleep' THEN 3 ELSE 4 END, id`,
    )
    .all(user.id) as FullHabitRow[];
  const customDone = loadCustomDone(db, arc, user.id);

  const doneIds = new Set(
    (db
      .prepare("SELECT habit_id FROM checkin WHERE user_id = ? AND date = ? AND status = 'done'")
      .all(user.id, date) as { habit_id: number }[]).map((r) => r.habit_id),
  );

  const history = loadHistories(db, arc, user.id).get(user.id)!;
  const week = workoutWeeks(arc, today, history.workout, history.perWeek, history.paused).find(
    (w) => date >= w.from && date <= w.to,
  );

  const inArc = date >= arc.startDate && date <= arc.endDate;
  return {
    date,
    today,
    yesterday: addDays(today, -1),
    state: today < arc.startDate ? 'before' : today > arc.endDate ? 'after' : 'active',
    dayNumber: inArc ? diffDays(date, arc.startDate) + 1 : null,
    totalDays: arcTotalDays(arc),
    startDate: arc.startDate,
    editable: isEditable(date, today, arc),
    habits: habits.map((h) => ({
      id: h.id,
      kind: h.kind,
      title: h.title,
      done: doneIds.has(h.id),
      type: h.type,
      target: h.target,
      progress:
        h.kind === 'custom'
          ? habitProgress(
              arc, today, { type: h.type, target: h.target, createdAt: h.created_at },
              customDone.get(h.id) ?? new Set(), history.paused, date,
            )
          : null,
    })),
    workout: week ? { done: week.done, target: week.target } : { done: 0, target: user.workoutsPerWeek },
    norms: { kcal: user.kcal, sleepHours: user.sleepHours },
    streak: computeStreak(arc, today, history),
    paused: history.paused.has(date),
    pauseEndsOn: pauseEndsOn(db, arc, user.id, date),
    pauseDaysLeft: pauseDaysLeft(db, arc, user.id),
  };
}
