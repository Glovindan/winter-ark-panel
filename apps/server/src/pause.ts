import {
  addDays,
  MAX_PAUSE_REQUEST_DAYS,
  MAX_PAUSE_TOTAL_DAYS,
  type ArcRange,
  type DateStr,
} from '@ark/shared';
import type { Db } from './db';
import { loadPausedDates } from './history';

export type PauseResult =
  | { ok: true; from: DateStr; to: DateStr; daysLeft: number }
  | { ok: false; error: 'invalid_days' | 'out_of_window' | 'pause_limit'; daysLeft: number };

const pausedCount = (db: Db, arc: ArcRange, userId: number) => loadPausedDates(db, arc, userId).get(userId)?.size ?? 0;

export const pauseDaysLeft = (db: Db, arc: ArcRange, userId: number) =>
  Math.max(0, MAX_PAUSE_TOTAL_DAYS - pausedCount(db, arc, userId));

/** Последний день непрерывной паузы, в которую попадает дата, либо null. */
export function pauseEndsOn(db: Db, arc: ArcRange, userId: number, date: DateStr): DateStr | null {
  const paused = loadPausedDates(db, arc, userId).get(userId);
  if (!paused?.has(date)) return null;
  let end = date;
  while (paused.has(addDays(end, 1))) end = addDays(end, 1);
  return end;
}

/**
 * Ставит паузу на `days` дней начиная с `from`. Начало не раньше вчерашнего дня (окно правки)
 * и не вне арки; всего на арку можно взять MAX_PAUSE_TOTAL_DAYS дней паузы.
 */
export function addPause(db: Db, arc: ArcRange, userId: number, today: DateStr, from: DateStr, days: number): PauseResult {
  const left = pauseDaysLeft(db, arc, userId);
  if (!Number.isInteger(days) || days < 1 || days > MAX_PAUSE_REQUEST_DAYS) return { ok: false, error: 'invalid_days', daysLeft: left };
  if (from < addDays(today, -1) || from < arc.startDate || from > arc.endDate) return { ok: false, error: 'out_of_window', daysLeft: left };

  const to = addDays(from, days - 1) > arc.endDate ? arc.endDate : addDays(from, days - 1);
  const existing = loadPausedDates(db, arc, userId).get(userId) ?? new Set<DateStr>();
  const union = new Set(existing);
  for (let d = from; d <= to; d = addDays(d, 1)) union.add(d);
  if (union.size > MAX_PAUSE_TOTAL_DAYS) return { ok: false, error: 'pause_limit', daysLeft: left };

  db.prepare('INSERT INTO pause (user_id, start_date, end_date) VALUES (?, ?, ?)').run(userId, from, to);
  return { ok: true, from, to, daysLeft: MAX_PAUSE_TOTAL_DAYS - union.size };
}

/** Снимает паузу, начиная с даты `from` (не раньше вчерашнего дня). Возвращает число освобождённых дней. */
export function cancelPause(db: Db, arc: ArcRange, userId: number, today: DateStr, from: DateStr): number | 'out_of_window' {
  if (from < addDays(today, -1)) return 'out_of_window';
  const before = pausedCount(db, arc, userId);
  const rows = db
    .prepare('SELECT id, start_date, end_date FROM pause WHERE user_id = ? AND end_date >= ?')
    .all(userId, from) as { id: number; start_date: DateStr; end_date: DateStr }[];
  const del = db.prepare('DELETE FROM pause WHERE id = ?');
  const cut = db.prepare('UPDATE pause SET end_date = ? WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) {
      if (r.start_date >= from) del.run(r.id);
      else cut.run(addDays(from, -1), r.id);
    }
  })();
  return before - pausedCount(db, arc, userId);
}
