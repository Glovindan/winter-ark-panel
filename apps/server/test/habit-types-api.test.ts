import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';
import { buildPoll, todayOf } from '../src/poll';

const TODAY = '2026-10-21'; // среда, день 3 арки
const YESTERDAY = '2026-10-20';

async function setup() {
  const config = loadConfig({ SESSION_SECRET: 's', DEV_AUTH: '1', DEV_TODAY: TODAY });
  const db = openDb(':memory:');
  const app = await buildApp(config, db);
  const login = async (id: number) => {
    const res = await app.inject({ method: 'POST', url: '/auth', payload: { dev: { id, name: `U${id}` } } });
    const headers = { authorization: `Bearer ${res.json().token}` };
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers, payload });
    const create = async (body: object) => (await call('POST', '/habits', body)).json();
    const tick = async (habitId: number, date = TODAY, done = true) =>
      (await call('PUT', '/checkin', { habitId, date, done })).json();
    const habit = async (id: number) => ((await call('GET', '/today')).json().habits as { id: number }[]).find((h) => h.id === id) as any;
    return { id: res.json().user.id as number, call, create, tick, habit };
  };
  return { config, db, login };
}

describe('создание пунктов с типом', () => {
  it('по умолчанию ежедневный без цели', async () => {
    const { login } = await setup();
    const u = await login(1);
    const h = await u.create({ title: 'Читать' });
    expect(h).toMatchObject({ type: 'daily', target: null, progress: null });
    expect(await u.habit(h.id)).toMatchObject({ type: 'daily', target: null, progress: null });
  });

  it('«N раз в неделю»: в неделю создания цель пропорциональна оставшимся дням', async () => {
    const { login } = await setup();
    const u = await login(1);
    const h = await u.create({ title: 'Бассейн', type: 'weekly', target: 3 });
    expect(h).toMatchObject({ type: 'weekly', target: 3 });
    // создан в среду: активны ср–вс = 5 дней, round(3·5/7) = 2
    expect((await u.habit(h.id)).progress).toEqual({ kind: 'week', done: 0, target: 2 });
  });

  it('«Цель на арку»', async () => {
    const { login } = await setup();
    const u = await login(1);
    const h = await u.create({ title: 'Прочитать книги', type: 'arc_total', target: 5 });
    expect((await u.habit(h.id)).progress).toEqual({ kind: 'arc', done: 0, target: 5 });
  });

  it.each([
    [{ type: 'weekly' }],
    [{ type: 'weekly', target: 0 }],
    [{ type: 'weekly', target: 8 }],
    [{ type: 'weekly', target: 2.5 }],
    [{ type: 'daily', target: 3 }],
    [{ type: 'arc_total', target: 366 }],
    [{ type: 'arc_total', target: '10' }],
    [{ type: 'monthly', target: 1 }],
  ])('отклоняет %j', async (extra) => {
    const { login } = await setup();
    const u = await login(1);
    expect((await u.call('POST', '/habits', { title: 'X', ...extra })).statusCode).toBe(400);
  });

  it('лимит 10 пунктов общий для всех типов', async () => {
    const { login } = await setup();
    const u = await login(1);
    for (let i = 0; i < 4; i++) await u.create({ title: `d${i}` });
    for (let i = 0; i < 3; i++) await u.create({ title: `w${i}`, type: 'weekly', target: 2 });
    for (let i = 0; i < 3; i++) await u.create({ title: `a${i}`, type: 'arc_total', target: 10 });
    expect((await u.call('POST', '/habits', { title: 'лишний', type: 'weekly', target: 1 })).statusCode).toBe(409);
  });

  it('пункты старого формата остаются ежедневными', async () => {
    const { db, login } = await setup();
    const u = await login(1);
    db.prepare("INSERT INTO habit (kind, owner_id, title) VALUES ('custom', ?, 'Старый')").run(u.id); // без типа, как до миграции
    const habits = (await u.call('GET', '/today')).json().habits;
    expect(habits.find((h: { title: string }) => h.title === 'Старый')).toMatchObject({ type: 'daily', target: null, progress: null });
  });
});

describe('отметки и прогресс', () => {
  it('неделя: отметки копятся, сверх нормы счётчик растёт', async () => {
    const { login } = await setup();
    const u = await login(1);
    const h = await u.create({ title: 'Растяжка', type: 'weekly', target: 1 });

    const first = await u.tick(h.id, YESTERDAY);
    expect(first.habits.find((x: { id: number }) => x.id === h.id).progress).toEqual({ kind: 'week', done: 1, target: 1 });
    const second = await u.tick(h.id, TODAY);
    expect(second.habits.find((x: { id: number }) => x.id === h.id).progress).toEqual({ kind: 'week', done: 2, target: 1 });

    const undone = await u.tick(h.id, TODAY, false);
    expect(undone.habits.find((x: { id: number }) => x.id === h.id).progress.done).toBe(1);
  });

  it('арка: общий счётчик за все дни', async () => {
    const { login } = await setup();
    const u = await login(1);
    const h = await u.create({ title: 'Бассейн', type: 'arc_total', target: 5 });
    await u.tick(h.id, YESTERDAY);
    await u.tick(h.id, TODAY);
    expect((await u.habit(h.id)).progress).toEqual({ kind: 'arc', done: 2, target: 5 });
  });

  it('пауза блокирует отметку и недельного пункта', async () => {
    const { login } = await setup();
    const u = await login(1);
    const h = await u.create({ title: 'Бассейн', type: 'weekly', target: 2 });
    await u.call('POST', '/pause', { days: 2 });
    const res = await u.call('PUT', '/checkin', { habitId: h.id, date: TODAY, done: true });
    expect(res.statusCode).toBe(409);
  });

  it('чужой пункт отметить нельзя', async () => {
    const { login } = await setup();
    const a = await login(1);
    const b = await login(2);
    const h = await a.create({ title: 'Бассейн', type: 'weekly', target: 2 });
    expect((await b.call('PUT', '/checkin', { habitId: h.id, date: TODAY, done: true })).statusCode).toBe(404);
  });
});

describe('видимость другим участникам и бот', () => {
  it('в деталях участника есть тип, цель и дата создания', async () => {
    const { login } = await setup();
    const a = await login(1);
    const b = await login(2);
    const h = await a.create({ title: 'Бассейн', type: 'weekly', target: 2 });
    const detail = (await b.call('GET', `/users/${a.id}/days`)).json();
    expect(detail.habits.find((x: { id: number }) => x.id === h.id)).toMatchObject({ type: 'weekly', target: 2, createdAt: TODAY });
    // фиксированные пункты остаются ежедневными
    expect(detail.habits.filter((x: { kind: string }) => x.kind !== 'custom').every((x: { type: string }) => x.type === 'daily')).toBe(true);
  });

  it('в вечернем опросе у пункта с целью виден прогресс', async () => {
    const { config, db, login } = await setup();
    const u = await login(7);
    await u.create({ title: 'Растяжка', type: 'weekly', target: 1 });
    await u.create({ title: 'Книги', type: 'arc_total', target: 5 });
    const poll = buildPoll(config, todayOf(db, config, 7)!);
    const labels = poll.markup.inline_keyboard.flat().map((b) => (b as { text: string }).text);
    expect(labels).toContain('⬜ Растяжка (0/1)');
    expect(labels).toContain('⬜ Книги (0/5)');
    expect(labels).toContain('⬜ Питание'); // у обязательных прогресса нет
  });
});
