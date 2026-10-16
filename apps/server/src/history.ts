import { addDays, type ArcRange, type DateStr, type History } from '@ark/shared';
import type { Db } from './db';

type FixedKind = 'nutrition' | 'workout' | 'sleep';

/** Все даты паузы участников внутри арки. */
export function loadPausedDates(db: Db, arc: ArcRange, userId?: number): Map<number, Set<DateStr>> {
  const args: (string | number)[] = [arc.endDate, arc.startDate];
  if (userId !== undefined) args.push(userId);
  const rows = db
    .prepare(
      `SELECT user_id, start_date, end_date FROM pause
       WHERE start_date <= ? AND end_date >= ? ${userId === undefined ? '' : 'AND user_id = ?'}`,
    )
    .all(...args) as {
    user_id: number;
    start_date: DateStr;
    end_date: DateStr;
  }[];

  const byUser = new Map<number, Set<DateStr>>();
  for (const r of rows) {
    let set = byUser.get(r.user_id);
    if (!set) byUser.set(r.user_id, (set = new Set()));
    const from = r.start_date < arc.startDate ? arc.startDate : r.start_date;
    const to = r.end_date > arc.endDate ? arc.endDate : r.end_date;
    for (let d = from; d <= to; d = addDays(d, 1)) set.add(d);
  }
  return byUser;
}

/** Истории участников: отметки обязательных пунктов и паузы. Без userId возвращает всех. */
export function loadHistories(db: Db, arc: ArcRange, userId?: number): Map<number, History> {
  const users = db
    .prepare(`SELECT id, workouts_per_week FROM user ${userId === undefined ? '' : 'WHERE id = ?'} ORDER BY id`)
    .all(...(userId === undefined ? [] : [userId])) as { id: number; workouts_per_week: number }[];

  const args: (string | number)[] = [arc.startDate, arc.endDate];
  if (userId !== undefined) args.push(userId);
  const rows = db
    .prepare(
      `SELECT c.user_id, h.kind, c.date FROM checkin c JOIN habit h ON h.id = c.habit_id
       WHERE c.status = 'done' AND h.owner_id IS NULL AND c.date BETWEEN ? AND ? ${userId === undefined ? '' : 'AND c.user_id = ?'}`,
    )
    .all(...args) as {
    user_id: number;
    kind: FixedKind;
    date: DateStr;
  }[];

  const paused = loadPausedDates(db, arc, userId);
  const map = new Map<number, { nutrition: Set<DateStr>; sleep: Set<DateStr>; workout: Set<DateStr> }>();
  for (const u of users) map.set(u.id, { nutrition: new Set(), sleep: new Set(), workout: new Set() });
  for (const r of rows) map.get(r.user_id)?.[r.kind].add(r.date);

  const result = new Map<number, History>();
  for (const u of users) {
    const done = map.get(u.id)!;
    result.set(u.id, { perWeek: u.workouts_per_week, ...done, paused: paused.get(u.id) ?? new Set() });
  }
  return result;
}
