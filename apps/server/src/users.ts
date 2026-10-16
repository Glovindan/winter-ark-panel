import type { UserProfile } from '@ark/shared';
import type { Db } from './db';

interface Row {
  id: number; tg_id: number; name: string; avatar_url: string | null;
  kcal: number | null; protein: number | null; fat: number | null; carb: number | null;
  sleep_hours: number; workouts_per_week: number; poll_time: string;
}

function toProfile(r: Row, adminTgId: number | null): UserProfile {
  return {
    id: r.id, tgId: r.tg_id, name: r.name, avatarUrl: r.avatar_url,
    kcal: r.kcal, protein: r.protein, fat: r.fat, carb: r.carb,
    sleepHours: r.sleep_hours, workoutsPerWeek: r.workouts_per_week, pollTime: r.poll_time,
    isAdmin: adminTgId !== null && r.tg_id === adminTgId,
  };
}

/** Создаёт пользователя при первом входе, при повторных обновляет имя и аватарку. */
export function upsertUser(
  db: Db,
  tg: { id: number; name: string; avatarUrl: string | null },
  adminTgId: number | null,
): UserProfile {
  db.prepare(
    `INSERT INTO user (tg_id, name, avatar_url) VALUES (@id, @name, @avatarUrl)
     ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url`,
  ).run(tg);
  return getUserByTgId(db, tg.id, adminTgId)!;
}

export function getUserByTgId(db: Db, tgId: number, adminTgId: number | null): UserProfile | null {
  const r = db.prepare('SELECT * FROM user WHERE tg_id = ?').get(tgId) as Row | undefined;
  return r ? toProfile(r, adminTgId) : null;
}
