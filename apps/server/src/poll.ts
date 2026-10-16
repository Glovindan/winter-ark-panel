import { InlineKeyboard } from 'grammy';
import type { TodayResponse } from '@ark/shared';
import { clockInTz, minutesOfDay } from './clock';
import type { Config } from './config';
import type { Db } from './db';
import { buildToday, currentDate, getArc } from './today';
import { getUserByTgId } from './users';

export interface Poll {
  text: string;
  markup: InlineKeyboard;
}

const dateLabel = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

export function buildPoll(config: Config, today: TodayResponse): Poll {
  const markup = new InlineKeyboard();
  today.habits.forEach((h, i) => {
    if (i > 0) markup.row();
    const progress = h.progress ? ` (${h.progress.done}/${h.progress.target})` : '';
    markup.text(`${h.done ? '✅' : '⬜'} ${h.title}${progress}`, `t:${h.id}:${today.date}`);
  });
  if (config.webAppUrl) markup.row().webApp('Открыть панель', config.webAppUrl);

  const { done, target } = today.workout;
  const { current, freezesLeft } = today.streak;
  const text = [
    `Опрос за ${dateLabel(today.date)}`,
    'Нажимай на пункты, которые выполнил.',
    `Тренировок за неделю: ${Math.min(done, target)} из ${target}`,
    current > 0 ? `🔥 Серия: ${current} дн. (заморозок: ${freezesLeft})` : '',
  ].filter(Boolean).join('\n');
  return { text, markup };
}

/** Сегодняшний день участника, зарегистрированного по tg_id. */
export function todayOf(db: Db, config: Config, tgId: number): TodayResponse | null {
  const user = getUserByTgId(db, tgId, config.adminTgId);
  if (!user) return null;
  const arc = getArc(db);
  const today = currentDate(config, arc);
  return buildToday(db, user, today, today, arc);
}

/** Опрос на сегодня; null, если участника нет или у него сегодня пауза. */
export function pollFor(db: Db, config: Config, tgId: number): Poll | null {
  const today = todayOf(db, config, tgId);
  return today && !today.paused ? buildPoll(config, today) : null;
}

const POLL_WINDOW_MIN = 120;

export type SendPoll = (tgId: number, poll: Poll) => Promise<void>;

/**
 * Рассылает вечерний опрос тем, у кого время опроса уже наступило (не более чем 2 часа назад)
 * и кому опрос за сегодня ещё не отправлялся. Запускается раз в минуту; возвращает число отправок.
 */
export async function pollTick(db: Db, config: Config, send: SendPoll, now: Date = new Date()): Promise<number> {
  const arc = getArc(db);
  const today = currentDate(config, arc);
  if (today < arc.startDate || today > arc.endDate) return 0;

  const nowMin = minutesOfDay(clockInTz(arc.tz, now));
  const candidates = db
    .prepare(
      `SELECT tg_id, poll_time FROM user
       WHERE tg_id > 0 AND NOT EXISTS (SELECT 1 FROM poll_log p WHERE p.user_id = user.id AND p.date = ?)`,
    )
    .all(today) as { tg_id: number; poll_time: string }[];

  const claim = db.prepare('INSERT OR IGNORE INTO poll_log (user_id, date) SELECT id, ? FROM user WHERE tg_id = ?');
  const unclaim = db.prepare('DELETE FROM poll_log WHERE date = ? AND user_id = (SELECT id FROM user WHERE tg_id = ?)');

  let sent = 0;
  for (const c of candidates) {
    const at = minutesOfDay(c.poll_time);
    if (nowMin < at || nowMin >= at + POLL_WINDOW_MIN) continue;
    if (claim.run(today, c.tg_id).changes === 0) continue;
    const poll = pollFor(db, config, c.tg_id);
    if (!poll) continue;
    try {
      await send(c.tg_id, poll);
      sent++;
    } catch (e) {
      // 4xx (бот заблокирован, чат не найден) — окончательно, кроме 429. Сеть и 5xx повторим на следующем тике.
      const code = (e as { error_code?: number }).error_code;
      const permanent = code !== undefined && code >= 400 && code < 500 && code !== 429;
      if (!permanent) unclaim.run(today, c.tg_id);
      console.error(`poll to ${c.tg_id} failed:`, (e as Error).message);
    }
  }
  return sent;
}

export function startScheduler(db: Db, config: Config, send: SendPoll): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollTick(db, config, send);
    } catch (e) {
      console.error('poll tick failed:', e);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, 60_000);
  return () => clearInterval(timer);
}
