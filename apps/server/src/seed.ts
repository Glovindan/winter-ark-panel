/**
 * Dev-only: наполняет БД выдуманными участниками с отметками до даты `--today` (по умолчанию DEV_TODAY).
 * Выдуманные участники имеют отрицательный tg_id; `--clean` удаляет их вместе с отметками.
 *
 *   npm run seed -w @ark/server -- --today 2026-12-01
 *   npm run seed -w @ark/server -- --clean
 */
import { addDays, isDateStr } from '@ark/shared';
import { loadConfig } from './config';
import { openDb } from './db';
import { getArc } from './today';

if (process.env.NODE_ENV === 'production') throw new Error('seed нельзя запускать в production');

const config = loadConfig();
const db = openDb(config.dbPath);
const args = process.argv.slice(2);

if (args.includes('--clean')) {
  const r = db.prepare('DELETE FROM user WHERE tg_id < 0').run();
  console.log(`удалено выдуманных участников: ${r.changes}`);
  process.exit(0);
}

const i = args.indexOf('--today');
const today = i >= 0 ? args[i + 1] : config.devToday;
if (!today || !isDateStr(today)) throw new Error('укажи дату: --today YYYY-MM-DD или DEV_TODAY в .env');

const NAMES = [
  'Анна Смирнова', 'Дмитрий Орлов', 'Мария Ковалёва', 'Артём Волков', 'Екатерина Лебедева',
  'Игорь Соколов', 'Ольга Морозова', 'Павел Новиков', 'Светлана Попова', 'Кирилл Зайцев',
  'Наталья Павлова', 'Максим Фёдоров',
];

// детерминированный ГПСЧ, чтобы сид был воспроизводимым
let s = 42;
const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);

const arc = getArc(db);
const habits = db.prepare('SELECT id, kind FROM habit WHERE owner_id IS NULL').all() as { id: number; kind: string }[];
const idOf = (k: string) => habits.find((h) => h.kind === k)!.id;

const insertUser = db.prepare(
  'INSERT INTO user (tg_id, name, workouts_per_week) VALUES (?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET name = excluded.name RETURNING id',
);
const insertCheckin = db.prepare(
  "INSERT OR IGNORE INTO checkin (user_id, habit_id, date, status) VALUES (?, ?, ?, 'done')",
);

db.transaction(() => {
  NAMES.forEach((name, n) => {
    const perWeek = 2 + (n % 4);
    const { id } = insertUser.get(-(n + 1), name, perWeek) as { id: number };
    const discipline = 0.45 + rnd() * 0.5; // у каждого свой уровень собранности
    for (let d = arc.startDate; d <= today && d <= arc.endDate; d = addDays(d, 1)) {
      if (rnd() < discipline) insertCheckin.run(id, idOf('nutrition'), d);
      if (rnd() < discipline) insertCheckin.run(id, idOf('sleep'), d);
      if (rnd() < (discipline * perWeek) / 7 + 0.05) insertCheckin.run(id, idOf('workout'), d);
    }
  });
})();

console.log(`готово: ${NAMES.length} участников, отметки с ${arc.startDate} по ${today}`);
