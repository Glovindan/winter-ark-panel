import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { backupTick } from '../src/backup';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';

const dirs: string[] = [];
const dbs: { close(): void }[] = [];
afterEach(() => {
  dbs.splice(0).forEach((d) => d.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ark-backup-'));
  dirs.push(dir);
  const config = loadConfig({ SESSION_SECRET: 's', DB_PATH: join(dir, 'ark.db') });
  const db = openDb(config.dbPath);
  dbs.push(db);
  db.prepare("INSERT INTO user (tg_id, name) VALUES (1, 'Аня')").run();
  const sent: string[] = [];
  const send = async (_p: string, name: string) => void sent.push(name);
  return { db, config, sent, send };
}

describe('backupTick', () => {
  it('до 04:00 по Москве не делает копию', async () => {
    const t = setup();
    expect(await backupTick(t.db, t.config, t.send, new Date('2026-10-21T00:30:00Z'))).toBe(false); // 03:30 МСК
    expect(t.sent).toEqual([]);
  });

  it('после 04:00 делает целостную копию, отправляет и не повторяет в тот же день', async () => {
    const t = setup();
    const at = new Date('2026-10-21T01:30:00Z'); // 04:30 МСК
    expect(await backupTick(t.db, t.config, t.send, at)).toBe(true);
    expect(t.sent).toEqual(['ark-2026-10-21.db']);

    const copy = new Database(join(t.config.backupDir, 'ark-2026-10-21.db'), { readonly: true });
    expect(copy.prepare('SELECT name FROM user').get()).toEqual({ name: 'Аня' });
    copy.close();

    expect(await backupTick(t.db, t.config, t.send, new Date('2026-10-21T10:00:00Z'))).toBe(false);
    expect(t.sent).toHaveLength(1);
  });

  it('хранит только 7 последних копий', async () => {
    const t = setup();
    for (let day = 10; day <= 20; day++) {
      await backupTick(t.db, t.config, t.send, new Date(`2026-10-${day}T01:30:00Z`));
    }
    const files = readdirSync(t.config.backupDir).sort();
    expect(files).toHaveLength(7);
    expect(files[0]).toBe('ark-2026-10-14.db');
    expect(files.at(-1)).toBe('ark-2026-10-20.db');
  });

  it('ошибка отправки не ломает копию и не вызывает повторов', async () => {
    const t = setup();
    const fail = async () => { throw new Error('telegram down'); };
    const at = new Date('2026-10-21T01:30:00Z');
    expect(await backupTick(t.db, t.config, fail, at)).toBe(true);
    expect(existsSync(join(t.config.backupDir, 'ark-2026-10-21.db'))).toBe(true);
    expect(await backupTick(t.db, t.config, t.send, at)).toBe(false);
  });

  it('для базы в памяти ничего не делает', async () => {
    const config = loadConfig({ SESSION_SECRET: 's', DB_PATH: ':memory:' });
    const db = openDb(':memory:');
    expect(await backupTick(db, config, async () => undefined, new Date('2026-10-21T01:30:00Z'))).toBe(false);
  });
});
