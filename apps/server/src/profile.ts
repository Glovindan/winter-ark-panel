import type { ProfileUpdate } from '@ark/shared';
import type { Db } from './db';

const COLUMNS: Record<keyof ProfileUpdate, string> = {
  kcal: 'kcal',
  protein: 'protein',
  fat: 'fat',
  carb: 'carb',
  sleepHours: 'sleep_hours',
  workoutsPerWeek: 'workouts_per_week',
  pollTime: 'poll_time',
};

const nullableInt = (max: number) => (v: unknown) =>
  v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max);

const VALIDATORS: Record<keyof ProfileUpdate, (v: unknown) => boolean> = {
  kcal: nullableInt(20000),
  protein: nullableInt(1000),
  fat: nullableInt(1000),
  carb: nullableInt(2000),
  sleepHours: (v) => typeof v === 'number' && v >= 3 && v <= 14 && Number.isInteger(v * 2),
  workoutsPerWeek: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 7,
  pollTime: (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
};

/** Возвращает текст ошибки или null; применяет только известные поля. */
export function updateProfile(db: Db, userId: number, body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'invalid_body';
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) return 'empty_update';
  for (const [key, value] of entries) {
    if (!(key in COLUMNS)) return `unknown_field:${key}`;
    if (!VALIDATORS[key as keyof ProfileUpdate](value)) return `invalid_field:${key}`;
  }
  const sets = entries.map(([k]) => `${COLUMNS[k as keyof ProfileUpdate]} = @${k}`).join(', ');
  db.prepare(`UPDATE user SET ${sets} WHERE id = @id`).run({ ...Object.fromEntries(entries), id: userId });
  return null;
}
