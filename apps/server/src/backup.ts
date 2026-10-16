import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { todayInTz } from '@ark/shared';
import { clockInTz, minutesOfDay } from './clock';
import type { Config } from './config';
import type { Db } from './db';
import { getArc } from './today';

const BACKUP_AT = '04:00';
const KEEP = 7;
const FILE_RE = /^ark-\d{4}-\d{2}-\d{2}\.db$/;

export type SendFile = (path: string, filename: string) => Promise<void>;

/**
 * Раз в сутки после 04:00 (по времени арки) делает целостную копию SQLite, хранит последние 7
 * и отправляет свежую через send (в Telegram админу). Возвращает true, если копия сделана.
 */
export async function backupTick(db: Db, config: Config, send: SendFile, now: Date = new Date()): Promise<boolean> {
  if (config.dbPath === ':memory:') return false;
  const arc = getArc(db);
  if (minutesOfDay(clockInTz(arc.tz, now)) < minutesOfDay(BACKUP_AT)) return false;

  const date = todayInTz(arc.tz, now);
  const last = db.prepare("SELECT value FROM setting WHERE key = 'last_backup'").get() as { value: string } | undefined;
  if (last?.value === date) return false;

  mkdirSync(config.backupDir, { recursive: true });
  const filename = `ark-${date}.db`;
  const path = join(config.backupDir, filename);
  rmSync(path, { force: true });
  await db.backup(path);
  db.prepare("INSERT INTO setting (key, value) VALUES ('last_backup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(date);

  const old = readdirSync(config.backupDir).filter((f) => FILE_RE.test(f)).sort().slice(0, -KEEP);
  for (const f of old) rmSync(join(config.backupDir, f), { force: true });

  try {
    await send(path, filename);
  } catch (e) {
    console.error('backup send failed:', (e as Error).message);
  }
  return true;
}

export function startBackupScheduler(db: Db, config: Config, send: SendFile): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await backupTick(db, config, send);
    } catch (e) {
      console.error('backup failed:', e);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, 10 * 60_000);
  return () => clearInterval(timer);
}
