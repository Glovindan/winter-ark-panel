import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';
import { validateInitData } from '../src/telegramAuth';

const BOT_TOKEN = '123456:TEST-TOKEN';

function signInitData(fields: Record<string, string>, token = BOT_TOKEN): string {
  const dcs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const nowSec = () => Math.floor(Date.now() / 1000);
const userJson = JSON.stringify({ id: 42, first_name: 'Ivan', last_name: 'P', photo_url: 'https://t.me/i/u.jpg' });

describe('validateInitData', () => {
  it('принимает корректную подпись', () => {
    const raw = signInitData({ auth_date: String(nowSec()), user: userJson });
    expect(validateInitData(raw, BOT_TOKEN)?.user.id).toBe(42);
  });
  it('отклоняет подпись другим токеном', () => {
    const raw = signInitData({ auth_date: String(nowSec()), user: userJson }, 'other:token');
    expect(validateInitData(raw, BOT_TOKEN)).toBeNull();
  });
  it('отклоняет подменённые данные', () => {
    const raw = signInitData({ auth_date: String(nowSec()), user: userJson });
    expect(validateInitData(raw.replace('Ivan', 'Evil'), BOT_TOKEN)).toBeNull();
  });
  it('отклоняет просроченные данные', () => {
    const raw = signInitData({ auth_date: String(nowSec() - 3 * 86400), user: userJson });
    expect(validateInitData(raw, BOT_TOKEN)).toBeNull();
  });
  it('отклоняет пустой токен', () => {
    expect(validateInitData('hash=' + 'a'.repeat(64), '')).toBeNull();
  });
});

describe('POST /auth', () => {
  const setup = async (env: Record<string, string> = {}) => {
    const config = loadConfig({ BOT_TOKEN, SESSION_SECRET: 's', ADMIN_TG_ID: '42', ...env });
    const db = openDb(':memory:');
    return { app: await buildApp(config, db), db };
  };

  it('создаёт пользователя и отдаёт /me по токену', async () => {
    const { app, db } = await setup();
    const initData = signInitData({ auth_date: String(nowSec()), user: userJson });
    const res = await app.inject({ method: 'POST', url: '/auth', payload: { initData } });
    expect(res.statusCode).toBe(200);
    const { token, user } = res.json();
    expect(user.name).toBe('Ivan P');
    expect(user.isAdmin).toBe(true);
    expect(db.prepare('SELECT count(*) c FROM habit WHERE owner_id IS NULL').get()).toEqual({ c: 3 });

    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().tgId).toBe(42);
  });
  it('401 без токена и с плохой подписью', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: '/auth', payload: { initData: 'hash=zz' } });
    expect(bad.statusCode).toBe(401);
  });
  it('dev-вход работает только при DEV_AUTH=1', async () => {
    const off = await setup();
    const payload = { dev: { id: 7, name: 'Dev' } };
    expect((await off.app.inject({ method: 'POST', url: '/auth', payload })).statusCode).toBe(401);
    const on = await setup({ DEV_AUTH: '1' });
    expect((await on.app.inject({ method: 'POST', url: '/auth', payload })).statusCode).toBe(200);
  });
});
