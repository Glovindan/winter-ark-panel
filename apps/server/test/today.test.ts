import { describe, expect, it } from 'vitest';
import { addDays, isEditable, weekStart } from '@ark/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';

// Арка стартует в пн 19.10, поэтому 21.10 (ср) — день 3 первой недели.
const TODAY = '2026-10-21';

async function setup(devToday = TODAY) {
  const config = loadConfig({ SESSION_SECRET: 's', DEV_AUTH: '1', DEV_TODAY: devToday });
  const db = openDb(':memory:');
  const app = await buildApp(config, db);
  const login = async (id: number, name = `U${id}`) => {
    const res = await app.inject({ method: 'POST', url: '/auth', payload: { dev: { id, name } } });
    const h = { authorization: `Bearer ${res.json().token}` };
    const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
      app.inject({ method, url, headers: h, payload: payload as object | undefined });
    return { call };
  };
  return { app, db, login };
}

describe('shared dates', () => {
  it('неделя начинается с понедельника', () => {
    expect(weekStart('2026-10-19')).toBe('2026-10-19'); // пн
    expect(weekStart('2026-10-25')).toBe('2026-10-19'); // вс
    expect(weekStart('2026-10-26')).toBe('2026-10-26');
  });
  it('isEditable: сегодня и вчера внутри арки', () => {
    const arc = { startDate: '2026-10-19', endDate: '2027-02-28' };
    expect(isEditable('2026-10-21', '2026-10-21', arc)).toBe(true);
    expect(isEditable('2026-10-20', '2026-10-21', arc)).toBe(true);
    expect(isEditable('2026-10-19', '2026-10-21', arc)).toBe(false); // позавчера
    expect(isEditable('2026-10-22', '2026-10-21', arc)).toBe(false); // будущее
    expect(isEditable('2026-10-18', '2026-10-19', arc)).toBe(false); // до старта
    expect(isEditable('2027-03-01', '2027-03-01', arc)).toBe(false); // после конца
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('GET /today', () => {
  it('отдаёт три фиксированных пункта и номер дня', async () => {
    const { login } = await setup();
    const u = await login(1);
    const r = (await u.call('GET', '/today')).json();
    expect(r.habits.map((h: { kind: string }) => h.kind)).toEqual(['nutrition', 'workout', 'sleep']);
    expect(r.dayNumber).toBe(3);
    expect(r.totalDays).toBe(133);
    expect(r.state).toBe('active');
    expect(r.editable).toBe(true);
    expect(r.workout).toEqual({ done: 0, target: 3 });
  });
  it('до старта арки ничего нельзя править', async () => {
    const { login } = await setup('2026-10-15');
    const u = await login(1);
    const r = (await u.call('GET', '/today')).json();
    expect(r.state).toBe('before');
    expect(r.editable).toBe(false);
    expect(r.dayNumber).toBeNull();
    const put = await u.call('PUT', '/checkin', { habitId: r.habits[0].id, date: '2026-10-15', done: true });
    expect(put.statusCode).toBe(403);
  });
  it('400 на кривую дату и 401 без токена', async () => {
    const { app, login } = await setup();
    const u = await login(1);
    expect((await u.call('GET', '/today?date=2026-13-45')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/today' })).statusCode).toBe(401);
  });
});

describe('PUT /checkin', () => {
  it('ставит и снимает отметку, считает тренировки за неделю', async () => {
    const { login } = await setup();
    const u = await login(1);
    const habits = (await u.call('GET', '/today')).json().habits;
    const workout = habits.find((h: { kind: string }) => h.kind === 'workout').id;

    let r = (await u.call('PUT', '/checkin', { habitId: workout, date: TODAY, done: true })).json();
    expect(r.habits.find((h: { id: number }) => h.id === workout).done).toBe(true);
    expect(r.workout.done).toBe(1);

    r = (await u.call('PUT', '/checkin', { habitId: workout, date: addDays(TODAY, -1), done: true })).json();
    expect(r.workout.done).toBe(2); // вчера, та же неделя

    r = (await u.call('PUT', '/checkin', { habitId: workout, date: TODAY, done: false })).json();
    expect(r.workout.done).toBe(1);
  });
  it('повторная отметка идемпотентна', async () => {
    const { login, db } = await setup();
    const u = await login(1);
    const id = (await u.call('GET', '/today')).json().habits[0].id;
    await u.call('PUT', '/checkin', { habitId: id, date: TODAY, done: true });
    await u.call('PUT', '/checkin', { habitId: id, date: TODAY, done: true });
    expect(db.prepare('SELECT count(*) c FROM checkin').get()).toEqual({ c: 1 });
  });
  it('нельзя править позавчера и будущее', async () => {
    const { login } = await setup();
    const u = await login(1);
    const id = (await u.call('GET', '/today')).json().habits[0].id;
    expect((await u.call('PUT', '/checkin', { habitId: id, date: addDays(TODAY, -2), done: true })).statusCode).toBe(403);
    expect((await u.call('PUT', '/checkin', { habitId: id, date: addDays(TODAY, 1), done: true })).statusCode).toBe(403);
  });
  it('нельзя отмечать чужой личный пункт', async () => {
    const { login } = await setup();
    const a = await login(1);
    const b = await login(2);
    const mine = (await a.call('POST', '/habits', { title: 'Шаги' })).json();
    const res = await b.call('PUT', '/checkin', { habitId: mine.id, date: TODAY, done: true });
    expect(res.statusCode).toBe(404);
  });
  it('400 на неверное тело', async () => {
    const { login } = await setup();
    const u = await login(1);
    expect((await u.call('PUT', '/checkin', { habitId: 'x', date: TODAY, done: true })).statusCode).toBe(400);
    expect((await u.call('PUT', '/checkin', { habitId: 1, date: TODAY, done: 'yes' })).statusCode).toBe(400);
  });
});

describe('личные пункты', () => {
  it('создаются, видны только владельцу и удаляются', async () => {
    const { login } = await setup();
    const a = await login(1);
    const b = await login(2);
    const h = (await a.call('POST', '/habits', { title: '  10 000 шагов ' })).json();
    expect(h.title).toBe('10 000 шагов');
    expect((await a.call('GET', '/today')).json().habits).toHaveLength(4);
    expect((await b.call('GET', '/today')).json().habits).toHaveLength(3);
    expect((await b.call('DELETE', `/habits/${h.id}`)).statusCode).toBe(404);
    expect((await a.call('DELETE', `/habits/${h.id}`)).statusCode).toBe(204);
    expect((await a.call('GET', '/today')).json().habits).toHaveLength(3);
  });
  it('фиксированные удалить нельзя', async () => {
    const { login } = await setup();
    const u = await login(1);
    const id = (await u.call('GET', '/today')).json().habits[0].id;
    expect((await u.call('DELETE', `/habits/${id}`)).statusCode).toBe(404);
    expect((await u.call('GET', '/today')).json().habits).toHaveLength(3);
  });
  it('валидирует название и лимит', async () => {
    const { login } = await setup();
    const u = await login(1);
    expect((await u.call('POST', '/habits', { title: '   ' })).statusCode).toBe(400);
    expect((await u.call('POST', '/habits', { title: 'x'.repeat(61) })).statusCode).toBe(400);
    for (let i = 0; i < 10; i++) expect((await u.call('POST', '/habits', { title: `p${i}` })).statusCode).toBe(201);
    expect((await u.call('POST', '/habits', { title: 'лишний' })).statusCode).toBe(409);
  });
  it('удаление пункта убирает его отметки', async () => {
    const { login, db } = await setup();
    const u = await login(1);
    const h = (await u.call('POST', '/habits', { title: 'Вода' })).json();
    await u.call('PUT', '/checkin', { habitId: h.id, date: TODAY, done: true });
    await u.call('DELETE', `/habits/${h.id}`);
    expect(db.prepare('SELECT count(*) c FROM checkin').get()).toEqual({ c: 0 });
  });
});

describe('PUT /me', () => {
  it('сохраняет личные значения и они влияют на /today', async () => {
    const { login } = await setup();
    const u = await login(1);
    const res = await u.call('PUT', '/me', { kcal: 2300, protein: 150, sleepHours: 7.5, workoutsPerWeek: 4, pollTime: '22:30' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kcal: 2300, sleepHours: 7.5, workoutsPerWeek: 4, pollTime: '22:30' });
    const t = (await u.call('GET', '/today')).json();
    expect(t.workout.target).toBe(4);
    expect(t.norms).toEqual({ kcal: 2300, sleepHours: 7.5 });
  });
  it('kcal можно сбросить в null', async () => {
    const { login } = await setup();
    const u = await login(1);
    await u.call('PUT', '/me', { kcal: 2000 });
    expect((await u.call('PUT', '/me', { kcal: null })).json().kcal).toBeNull();
  });
  it.each([
    [{ workoutsPerWeek: 0 }],
    [{ workoutsPerWeek: 8 }],
    [{ sleepHours: 2 }],
    [{ sleepHours: 7.3 }],
    [{ pollTime: '25:00' }],
    [{ pollTime: '9:00' }],
    [{ kcal: -5 }],
    [{ kcal: 'много' }],
    [{ name: 'Хакер' }],
    [{ isAdmin: true }],
    [{}],
  ])('отклоняет %j', async (body) => {
    const { login } = await setup();
    const u = await login(1);
    expect((await u.call('PUT', '/me', body)).statusCode).toBe(400);
  });
});
