import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';

const TODAY = '2026-10-21';

async function setup() {
  const config = loadConfig({ SESSION_SECRET: 's', DEV_AUTH: '1', DEV_TODAY: TODAY });
  const db = openDb(':memory:');
  const app = await buildApp(config, db);
  const login = async (id: number) => {
    const res = await app.inject({ method: 'POST', url: '/auth', payload: { dev: { id, name: `U${id}` } } });
    const headers = { authorization: `Bearer ${res.json().token}` };
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
      app.inject({ method, url, headers, payload: payload as object | undefined });
    const habit = async (id: number) =>
      ((await call('GET', '/today')).json().habits as { id: number; title: string }[]).find((h) => h.id === id) as any;
    return { id: res.json().user.id as number, call, habit };
  };
  return { app, db, login };
}

describe('PUT /habits/:id (переименование личного пункта)', () => {
  it('меняет название и обрезает пробелы', async () => {
    const { login } = await setup();
    const u = await login(1);
    const h = (await u.call('POST', '/habits', { title: '8000 шагов' })).json();
    const res = await u.call('PUT', `/habits/${h.id}`, { title: '  10 000 шагов ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: h.id, title: '10 000 шагов' });
    expect((await u.habit(h.id)).title).toBe('10 000 шагов');
  });

  it('тип, цель, прогресс и отметки сохраняются', async () => {
    const { login } = await setup();
    const u = await login(1);
    const h = (await u.call('POST', '/habits', { title: 'Бассейн', type: 'weekly', target: 1 })).json();
    await u.call('PUT', '/checkin', { habitId: h.id, date: TODAY, done: true });
    await u.call('PUT', `/habits/${h.id}`, { title: 'Плавание' });
    expect(await u.habit(h.id)).toMatchObject({ title: 'Плавание', type: 'weekly', target: 1, done: true, progress: { kind: 'week', done: 1 } });
  });

  it('другие участники видят новое название в профиле', async () => {
    const { login } = await setup();
    const a = await login(1);
    const b = await login(2);
    const h = (await a.call('POST', '/habits', { title: 'Старое' })).json();
    await a.call('PUT', `/habits/${h.id}`, { title: 'Новое' });
    const detail = (await b.call('GET', `/users/${a.id}/days`)).json();
    expect(detail.habits.find((x: { id: number }) => x.id === h.id).title).toBe('Новое');
  });

  it.each([[''], ['   '], ['x'.repeat(61)], [undefined], [123 as unknown as string]])('отклоняет название %j', async (title) => {
    const { login } = await setup();
    const u = await login(1);
    const h = (await u.call('POST', '/habits', { title: 'Исходное' })).json();
    expect((await u.call('PUT', `/habits/${h.id}`, { title })).statusCode).toBe(400);
    expect((await u.habit(h.id)).title).toBe('Исходное');
  });

  it('можно использовать название ровно в 60 символов', async () => {
    const { login } = await setup();
    const u = await login(1);
    const h = (await u.call('POST', '/habits', { title: 'a' })).json();
    expect((await u.call('PUT', `/habits/${h.id}`, { title: 'я'.repeat(60) })).statusCode).toBe(200);
  });

  it('чужой пункт не переименовать', async () => {
    const { login } = await setup();
    const a = await login(1);
    const b = await login(2);
    const h = (await a.call('POST', '/habits', { title: 'Мой' })).json();
    expect((await b.call('PUT', `/habits/${h.id}`, { title: 'Взлом' })).statusCode).toBe(404);
    expect((await a.habit(h.id)).title).toBe('Мой');
  });

  it('обязательные пункты не переименовать', async () => {
    const { login } = await setup();
    const u = await login(1);
    const fixed = ((await u.call('GET', '/today')).json().habits as { id: number; title: string }[])[0]!;
    expect((await u.call('PUT', `/habits/${fixed.id}`, { title: 'Что-то другое' })).statusCode).toBe(404);
    expect((await u.habit(fixed.id)).title).toBe(fixed.title);
  });

  it('несуществующий пункт и запрос без токена', async () => {
    const { app, login } = await setup();
    const u = await login(1);
    expect((await u.call('PUT', '/habits/9999', { title: 'X' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/habits/1', payload: { title: 'X' } })).statusCode).toBe(401);
  });
});
