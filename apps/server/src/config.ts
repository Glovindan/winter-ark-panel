import { dirname, join } from 'node:path';
import { isDateStr } from '@ark/shared';

export interface Config {
  botToken: string;
  sessionSecret: string;
  adminTgId: number | null;
  port: number;
  dbPath: string;
  devAuth: boolean;
  /** Подмена «сегодня» (YYYY-MM-DD) для проверки арки до её старта; работает только вместе с DEV_AUTH */
  devToday: string | null;
  /** Бот и рассылка запускаются только при BOT_ENABLED=1 и заданном BOT_TOKEN */
  botEnabled: boolean;
  /** HTTPS-адрес Mini App для кнопки «Открыть панель» */
  webAppUrl: string | null;
  /** Куда складывать ежедневные копии БД (по умолчанию рядом с БД) */
  backupDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const devAuth = env.DEV_AUTH === '1';
  if (devAuth && env.NODE_ENV === 'production') {
    throw new Error('DEV_AUTH нельзя включать в production');
  }
  return {
    botToken: env.BOT_TOKEN ?? '',
    sessionSecret: env.SESSION_SECRET ?? 'change-me',
    adminTgId: env.ADMIN_TG_ID ? Number(env.ADMIN_TG_ID) : null,
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? './data/ark.db',
    devAuth,
    devToday: devAuth && env.DEV_TODAY && isDateStr(env.DEV_TODAY) ? env.DEV_TODAY : null,
    botEnabled: env.BOT_ENABLED === '1' && !!env.BOT_TOKEN,
    webAppUrl: env.WEBAPP_URL?.startsWith('https://') ? env.WEBAPP_URL : null,
    backupDir: env.BACKUP_DIR ?? join(dirname(env.DB_PATH ?? './data/ark.db'), 'backups'),
  };
}
