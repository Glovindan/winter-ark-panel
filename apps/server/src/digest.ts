import { addDays, computeStreak, weekStart, weekStatsList, type DateStr, type WeekStats } from '@ark/shared';
import { clockInTz, minutesOfDay } from './clock';
import type { Config } from './config';
import type { Db } from './db';
import { loadHistories } from './history';
import { currentDate, getArc, type Arc } from './today';

const DIGEST_AT = '10:00';
const TOP = 3;
const MIN_GROWTH = 0.1;
const MIN_STREAK = 3;

const getSetting = (db: Db, key: string) =>
  (db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
const putSetting = (db: Db, key: string, value: string) =>
  db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

export const getDigestChat = (db: Db): number | null => {
  const v = getSetting(db, 'digest_chat_id');
  return v === null ? null : Number(v);
};
export const setDigestChat = (db: Db, chatId: number) => putSetting(db, 'digest_chat_id', String(chatId));
export const clearDigestChat = (db: Db) => db.prepare("DELETE FROM setting WHERE key = 'digest_chat_id'").run();

const dayMonth = (d: DateStr) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
const pct = (x: number) => `${Math.round(x * 100)}%`;
const names = (list: string[]) => list.join(', ');

/** Последняя полностью закончившаяся неделя арки (понедельник) или null, если такой ещё нет. */
export function lastCompletedWeek(arc: Arc, today: DateStr): DateStr | null {
  const week = addDays(weekStart(today), -7);
  return week >= weekStart(arc.startDate) && week <= arc.endDate ? week : null;
}

/** Текст дайджеста за неделю, начинающуюся с `reportWeek`; null, если данных нет. */
export function buildDigestText(db: Db, arc: Arc, today: DateStr, reportWeek: DateStr): string | null {
  const users = db.prepare('SELECT id, name FROM user WHERE tg_id > 0 ORDER BY id').all() as { id: number; name: string }[];
  const histories = loadHistories(db, arc);

  const rows = users.flatMap((u) => {
    const h = histories.get(u.id)!;
    const weeks = weekStatsList(arc, today, h);
    const cur = weeks.find((w) => w.weekStart === reportWeek);
    if (!cur || cur.score === null) return [];
    const prev = weeks.find((w) => w.weekStart === addDays(reportWeek, -7));
    return [{ name: u.name, cur, prev, streak: computeStreak(arc, today, h).current }];
  });
  if (!rows.length) return null;

  const slots = (w: WeekStats) => 2 * w.activeDays + w.workoutTarget;
  const doneSlots = (w: WeekStats) => w.nutritionDone + w.sleepDone + w.workoutDone;
  const totalSlots = rows.reduce((s, r) => s + slots(r.cur), 0);
  const totalDone = rows.reduce((s, r) => s + doneSlots(r.cur), 0);

  const from = reportWeek < arc.startDate ? arc.startDate : reportWeek;
  const lastDay = addDays(reportWeek, 6) > arc.endDate ? arc.endDate : addDays(reportWeek, 6);
  const lines = [
    `📊 Итоги недели ${dayMonth(from)} – ${dayMonth(lastDay)}`,
    `Выполнено ${pct(totalDone / totalSlots)} всех слотов, участвуют ${rows.length}.`,
  ];

  const ranked = [...rows].sort((a, b) => b.cur.score! - a.cur.score! || a.name.localeCompare(b.name, 'ru')).slice(0, TOP);
  lines.push('', '🥇 Лидеры', ...ranked.map((r, i) => `${i + 1}. ${r.name}: ${pct(r.cur.score!)}`));

  const perfect = rows.filter((r) => r.cur.perfect).map((r) => r.name);
  if (perfect.length) lines.push('', `⭐ Идеальная неделя: ${names(perfect)}`);

  const growth = rows
    .filter((r) => r.prev && r.prev.score !== null)
    .map((r) => ({ name: r.name, delta: r.cur.score! - r.prev!.score! }))
    .filter((r) => r.delta >= MIN_GROWTH)
    .sort((a, b) => b.delta - a.delta || a.name.localeCompare(b.name, 'ru'))[0];
  if (growth) lines.push('', `📈 Рост недели: ${growth.name} (+${Math.round(growth.delta * 100)} п. п.)`);

  const streaker = [...rows].sort((a, b) => b.streak - a.streak || a.name.localeCompare(b.name, 'ru'))[0]!;
  if (streaker.streak >= MIN_STREAK) lines.push('', `🔥 Самая длинная серия сейчас: ${streaker.name}, ${streaker.streak} дн.`);

  const { c } = db
    .prepare('SELECT count(*) AS c FROM achievement WHERE unlocked_at >= ? AND unlocked_at < ?')
    .get(`${reportWeek} 00:00:00`, `${addDays(reportWeek, 7)} 00:00:00`) as { c: number };
  if (c > 0) lines.push('', `🏅 Новых ачивок за неделю: ${c}`);

  return lines.join('\n');
}

export type SendDigest = (chatId: number, text: string) => Promise<void>;

/**
 * По понедельникам после 10:00 (по времени арки) отправляет дайджест за прошедшую неделю в привязанный чат,
 * один раз за неделю. Возвращает true, если сообщение отправлено.
 */
export async function digestTick(db: Db, config: Config, send: SendDigest, now: Date = new Date()): Promise<boolean> {
  const chatId = getDigestChat(db);
  if (chatId === null) return false;

  const arc = getArc(db);
  const today = currentDate(config, arc);
  if (today !== weekStart(today) || minutesOfDay(clockInTz(arc.tz, now)) < minutesOfDay(DIGEST_AT)) return false;

  const week = lastCompletedWeek(arc, today);
  if (!week || getSetting(db, 'last_digest_week') === week) return false;

  const text = buildDigestText(db, arc, today, week);
  putSetting(db, 'last_digest_week', week); // считаем отправленным заранее, чтобы не дублировать
  if (!text) return false;

  try {
    await send(chatId, text);
    return true;
  } catch (e) {
    // 4xx (бота убрали из чата, нет прав) — окончательно; сеть и 5xx повторим на следующем тике
    const code = (e as { error_code?: number }).error_code;
    const permanent = code !== undefined && code >= 400 && code < 500 && code !== 429;
    if (!permanent) db.prepare("DELETE FROM setting WHERE key = 'last_digest_week'").run();
    console.error('digest send failed:', (e as Error).message);
    return false;
  }
}

export function startDigestScheduler(db: Db, config: Config, send: SendDigest): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await digestTick(db, config, send);
    } catch (e) {
      console.error('digest tick failed:', e);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, 10 * 60_000);
  return () => clearInterval(timer);
}
