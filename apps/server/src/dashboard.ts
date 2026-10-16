import {
  addDays,
  dailyRing,
  workoutRing,
  workoutWeeks,
  type DashboardResponse,
  type DateStr,
  type DetailHabit,
  type Rings,
  type UserDetailResponse,
} from '@ark/shared';
import type { Db } from './db';
import type { Arc } from './today';

interface UserRow { id: number; name: string; avatar_url: string | null; workouts_per_week: number }

type FixedKind = 'nutrition' | 'workout' | 'sleep';

function ringsFor(arc: Arc, today: DateStr, perWeek: number, dates: Record<FixedKind, DateStr[]>): Rings {
  return {
    nutrition: dailyRing(arc, today, dates.nutrition),
    workout: workoutRing(arc, today, dates.workout, perWeek),
    sleep: dailyRing(arc, today, dates.sleep),
  };
}

export function buildDashboard(db: Db, arc: Arc, today: DateStr): DashboardResponse {
  const users = db
    .prepare('SELECT id, name, avatar_url, workouts_per_week FROM user ORDER BY id')
    .all() as UserRow[];

  const rows = db
    .prepare(
      `SELECT c.user_id, h.kind, c.date FROM checkin c JOIN habit h ON h.id = c.habit_id
       WHERE c.status = 'done' AND h.owner_id IS NULL AND c.date BETWEEN ? AND ?`,
    )
    .all(arc.startDate, arc.endDate) as { user_id: number; kind: FixedKind; date: DateStr }[];

  const byUser = new Map<number, Record<FixedKind, DateStr[]>>();
  for (const r of rows) {
    let d = byUser.get(r.user_id);
    if (!d) byUser.set(r.user_id, (d = { nutrition: [], workout: [], sleep: [] }));
    d[r.kind].push(r.date);
  }

  return {
    today,
    startDate: arc.startDate,
    endDate: arc.endDate,
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      avatarUrl: u.avatar_url,
      rings: ringsFor(arc, today, u.workouts_per_week, byUser.get(u.id) ?? { nutrition: [], workout: [], sleep: [] }),
    })),
  };
}

export function buildUserDetail(db: Db, arc: Arc, today: DateStr, userId: number): UserDetailResponse | null {
  const u = db
    .prepare('SELECT id, name, avatar_url, workouts_per_week FROM user WHERE id = ?')
    .get(userId) as UserRow | undefined;
  if (!u) return null;

  const habits = db
    .prepare(
      `SELECT id, kind, title FROM habit WHERE owner_id IS NULL OR owner_id = ?
       ORDER BY CASE kind WHEN 'nutrition' THEN 1 WHEN 'workout' THEN 2 WHEN 'sleep' THEN 3 ELSE 4 END, id`,
    )
    .all(userId) as DetailHabit[];
  const kindById = new Map(habits.map((h) => [h.id, h.kind]));

  const checkins = db
    .prepare("SELECT habit_id, date FROM checkin WHERE user_id = ? AND status = 'done' AND date BETWEEN ? AND ?")
    .all(userId, arc.startDate, arc.endDate) as { habit_id: number; date: DateStr }[];

  const dates: Record<FixedKind, DateStr[]> = { nutrition: [], workout: [], sleep: [] };
  const doneByDay = new Map<DateStr, number[]>();
  for (const c of checkins) {
    const kind = kindById.get(c.habit_id);
    if (!kind) continue;
    if (kind !== 'custom') dates[kind].push(c.date);
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
    rings: ringsFor(arc, today, u.workouts_per_week, dates),
    habits,
    weeks: workoutWeeks(arc, today, dates.workout, u.workouts_per_week).filter((w) => w.from <= today),
    days,
  };
}
