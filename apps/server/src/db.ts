import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE arc (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    tz TEXT NOT NULL
  );
  INSERT INTO arc (id, start_date, end_date, tz)
    VALUES (1, '2026-10-19', '2027-02-28', 'Europe/Moscow');

  CREATE TABLE user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,
    avatar_url TEXT,
    kcal INTEGER, protein INTEGER, fat INTEGER, carb INTEGER,
    sleep_hours REAL NOT NULL DEFAULT 8,
    workouts_per_week INTEGER NOT NULL DEFAULT 3 CHECK (workouts_per_week BETWEEN 1 AND 7),
    poll_time TEXT NOT NULL DEFAULT '21:00',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE habit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('nutrition','workout','sleep','custom')),
    owner_id INTEGER REFERENCES user(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    CHECK ((kind = 'custom') = (owner_id IS NOT NULL))
  );
  INSERT INTO habit (kind, owner_id, title) VALUES
    ('nutrition', NULL, 'Питание'),
    ('workout', NULL, 'Тренировка'),
    ('sleep', NULL, 'Сон');

  CREATE TABLE checkin (
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    habit_id INTEGER NOT NULL REFERENCES habit(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('done','skipped')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, habit_id, date)
  );
  `,
  `
  CREATE TABLE setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE poll_log (
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, date)
  );
  `,
  `
  CREATE TABLE pause (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (start_date <= end_date)
  );
  CREATE INDEX pause_user ON pause(user_id);

  CREATE TABLE achievement (
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, code)
  );
  `,
];

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
