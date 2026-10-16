import {
  addDays,
  computeStreak,
  ringsOf,
  workoutWeeks,
  type DashboardResponse,
  type DateStr,
  type DetailHabit,
  type UserDetailResponse,
} from '@ark/shared';
import { unlockedOf } from './achievements';
import type { Db } from './db';
import { loadHistories } from './history';
import type { Arc } from './today';

interface UserRow { id: number; name: string; avatar_url: string | null; workouts_per_week: number }

export function buildDashboard(db: Db, arc: Arc, today: DateStr): DashboardResponse {
  const users = db
    .prepare('SELECT id, name, avatar_url, workouts_per_week FROM user ORDER BY id')
    .all() as UserRow[];
  const histories = loadHistories(db, arc);

  // последние три открытые ачивки каждого участника
  const badges = new Map<number, string[]>();
  for (const r of db
    .prepare('SELECT user_id, code FROM achievement ORDER BY unlocked_at DESC, rowid DESC')
    .all() as { user_id: number; code: string }[]) {
    const list = badges.get(r.user_id) ?? [];
    if (list.length < 3) list.push(r.code);
    badges.set(r.user_id, list);
  }

  return {
    today,
    startDate: arc.startDate,
    endDate: arc.endDate,
    users: users.map((u) => {
      const h = histories.get(u.id)!;
      return {
        id: u.id,
        name: u.name,
        avatarUrl: u.avatar_url,
        rings: ringsOf(arc, today, h),
        streak: computeStreak(arc, today, h).current,
        badges: badges.get(u.id) ?? [],
      };
    }),
  };
}

export function buildUserDetail(db: Db, arc: Arc, today: DateStr, userId: number): UserDetailResponse | null {
  const u = db
    .prepare('SELECT id, name, avatar_url, workouts_per_week FROM user WHERE id = ?')
    .get(userId) as UserRow | undefined;
  if (!u) return null;
  const h = loadHistories(db, arc, userId).get(userId)!;

  const habits = db
    .prepare(
      `SELECT id, kind, title FROM habit WHERE owner_id IS NULL OR owner_id = ?
       ORDER BY CASE kind WHEN 'nutrition' THEN 1 WHEN 'workout' THEN 2 WHEN 'sleep' THEN 3 ELSE 4 END, id`,
    )
    .all(userId) as DetailHabit[];

  // отметки по дням, включая личные пункты
  const doneByDay = new Map<DateStr, number[]>();
  for (const c of db
    .prepare("SELECT habit_id, date FROM checkin WHERE user_id = ? AND status = 'done' AND date BETWEEN ? AND ?")
    .all(userId, arc.startDate, arc.endDate) as { habit_id: number; date: DateStr }[]) {
    const list = doneByDay.get(c.date);
    if (list) list.push(c.habit_id);
    else doneByDay.set(c.date, [c.habit_id]);
  }

  const last = today < arc.endDate ? today : arc.endDate;
  const days: UserDetailResponse['days'] = [];
  for (let d = last; d >= arc.startDate; d = addDays(d, -1)) {
    days.push({ date: d, done: doneByDay.get(d) ?? [] });
  }

  return {
    user: { id: u.id, name: u.name, avatarUrl: u.avatar_url, workoutsPerWeek: u.workouts_per_week },
    today,
    rings: ringsOf(arc, today, h),
    streak: computeStreak(arc, today, h),
    achievements: unlockedOf(db, userId),
    paused: [...h.paused].sort(),
    habits,
    weeks: workoutWeeks(arc, today, h.workout, h.perWeek, h.paused).filter((w) => w.from <= today),
    days,
  };
}
