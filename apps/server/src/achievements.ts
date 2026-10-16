import {
  ACHIEVEMENTS,
  achievementByCode,
  evaluateAchievements,
  type AchievementDef,
  type History,
  type UnlockedAchievement,
} from '@ark/shared';
import type { Config } from './config';
import type { Db } from './db';
import { loadHistories } from './history';
import { currentDate, getArc } from './today';

export type Notify = (tgId: number, text: string) => Promise<void>;

export function unlockedOf(db: Db, userId: number): UnlockedAchievement[] {
  return (
    db.prepare('SELECT code, unlocked_at FROM achievement WHERE user_id = ? ORDER BY unlocked_at, rowid').all(userId) as {
      code: string;
      unlocked_at: string;
    }[]
  )
    .filter((r) => achievementByCode(r.code))
    .map((r) => ({ code: r.code, unlockedAt: r.unlocked_at }));
}

/** Проверяет условия и сохраняет новые ачивки. Открытые раньше не отзываются. */
export function refreshAchievements(
  db: Db,
  config: Config,
  userId: number,
  history?: History,
): AchievementDef[] {
  const arc = getArc(db);
  const today = currentDate(config, arc);
  const h = history ?? loadHistories(db, arc, userId).get(userId);
  if (!h) return [];
  const insert = db.prepare('INSERT OR IGNORE INTO achievement (user_id, code) VALUES (?, ?)');
  const fresh: AchievementDef[] = [];
  for (const code of evaluateAchievements(arc, today, h)) {
    if (insert.run(userId, code).changes === 1) fresh.push(achievementByCode(code)!);
  }
  return fresh.sort((a, b) => ACHIEVEMENTS.indexOf(a) - ACHIEVEMENTS.indexOf(b));
}

export function formatUnlocked(defs: AchievementDef[]): string {
  const head = defs.length === 1 ? '🏆 Новая ачивка!' : `🏆 Новые ачивки: ${defs.length}`;
  return [head, ...defs.map((d) => `${d.icon} ${d.title}: ${d.description}`)].join('\n');
}

/**
 * Проверка после изменения данных участника. Уведомление уходит в фоне и не задерживает ответ;
 * выдуманным участникам (tg_id < 0) ничего не отправляется.
 */
export function refreshAndNotify(
  db: Db,
  config: Config,
  user: { id: number; tgId: number },
  notify?: Notify,
): AchievementDef[] {
  const fresh = refreshAchievements(db, config, user.id);
  if (fresh.length && notify && user.tgId > 0) {
    notify(user.tgId, formatUnlocked(fresh)).catch((e) => console.error('achievement notify failed:', (e as Error).message));
  }
  return fresh;
}

/** Периодическая проверка: ачивки, которые зависят от времени (закрытие недели, 31 декабря, конец арки). */
export async function achievementsTick(db: Db, config: Config, notify: Notify): Promise<number> {
  const arc = getArc(db);
  if (currentDate(config, arc) < arc.startDate) return 0;
  const histories = loadHistories(db, arc);
  const users = db.prepare('SELECT id, tg_id FROM user WHERE tg_id > 0').all() as { id: number; tg_id: number }[];
  let unlocked = 0;
  for (const u of users) {
    const fresh = refreshAchievements(db, config, u.id, histories.get(u.id));
    if (!fresh.length) continue;
    unlocked += fresh.length;
    try {
      await notify(u.tg_id, formatUnlocked(fresh));
    } catch (e) {
      console.error(`achievement notify to ${u.tg_id} failed:`, (e as Error).message);
    }
  }
  return unlocked;
}

export function startAchievementScheduler(db: Db, config: Config, notify: Notify): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await achievementsTick(db, config, notify);
    } catch (e) {
      console.error('achievements tick failed:', e);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, 10 * 60_000);
  return () => clearInterval(timer);
}
