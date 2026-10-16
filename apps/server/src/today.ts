import {
  addDays,
  arcTotalDays,
  diffDays,
  isEditable,
  todayInTz,
  weekStart,
  type ArcRange,
  type DateStr,
  type TodayResponse,
  type UserProfile,
} from '@ark/shared';
import type { Config } from './config';
import type { Db } from './db';

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

export function buildToday(db: Db, user: UserProfile, date: DateStr, today: DateStr, arc: Arc): TodayResponse {
  const habits = db
    .prepare(
      `SELECT id, kind, title FROM habit WHERE owner_id IS NULL OR owner_id = ?
       ORDER BY CASE kind WHEN 'nutrition' THEN 1 WHEN 'workout' THEN 2 WHEN 'sleep' THEN 3 ELSE 4 END, id`,
    )
    .all(user.id) as HabitRow[];

  const doneIds = new Set(
    (db
      .prepare("SELECT habit_id FROM checkin WHERE user_id = ? AND date = ? AND status = 'done'")
      .all(user.id, date) as { habit_id: number }[]).map((r) => r.habit_id),
  );

  const ws = weekStart(date);
  const weekDone = (db
    .prepare(
      `SELECT count(*) AS c FROM checkin c JOIN habit h ON h.id = c.habit_id
       WHERE c.user_id = ? AND h.kind = 'workout' AND c.status = 'done' AND c.date BETWEEN ? AND ?`,
    )
    .get(user.id, ws, addDays(ws, 6)) as { c: number }).c;

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
    habits: habits.map((h) => ({ ...h, done: doneIds.has(h.id) })),
    workout: { done: weekDone, target: user.workoutsPerWeek },
    norms: { kcal: user.kcal, sleepHours: user.sleepHours },
  };
}
