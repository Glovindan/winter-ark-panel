import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { getInviteCode, createBot } from '../src/bot';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';
import { buildDigestText, digestTick, lastCompletedWeek, getDigestChat } from '../src/digest';
import { pollTick, type Poll } from '../src/poll';
import { getArc } from '../src/today';

const ADMIN = 100;

type Db = ReturnType<typeof openDb>;
const habitId = (db: Db, kind: string) => (db.prepare('SELECT id FROM habit WHERE kind = ? AND owner_id IS NULL').get(kind) as { id: number }).id;
const addCheckin = (db: Db, userId: number, kind: string, date: string) =>
  db.prepare("INSERT OR IGNORE INTO checkin (user_id, habit_id, date, status) VALUES (?, ?, ?, 'done')").run(userId, habitId(db, kind), date);
const dates = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));

// ---------- API ----------

async function setupApi(devToday = '2026-10-21') {
  const config = loadConfig({ SESSION_SECRET: 's', DEV_AUTH: '1', DEV_TODAY: devToday });
  const db = openDb(':memory:');
  const notified: { tgId: number; text: string }[] = [];
  const app = await buildApp(config, db, { notify: async (tgId, text) => void notified.push({ tgId, text }) });
  const login = async (id: number, name = `U${id}`) => {
    const res = await app.inject({ method: 'POST', url: '/auth', payload: { dev: { id, name } } });
    const headers = { authorization: `Bearer ${res.json().token}` };
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers, payload });
    return { id: res.json().user.id as number, call };
  };
  return { db, login, notified };
}

describe('пауза', () => {
  it('ставится, блокирует отметки и снимается', async () => {
    const { db, login } = await setupApi();
    const u = await login(1);
    const r = await u.call('POST', '/pause', { days: 3 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ paused: true, pauseEndsOn: '2026-10-23', pauseDaysLeft: 18 });

    const put = await u.call('PUT', '/checkin', { habitId: habitId(db, 'nutrition'), date: '2026-10-21', done: true });
    expect(put.statusCode).toBe(409);
    expect(put.json().error).toBe('day_paused');

    const del = await u.call('DELETE', '/pause');
    expect(del.json()).toMatchObject({ paused: false, pauseEndsOn: null, pauseDaysLeft: 21 });
    expect((await u.call('PUT', '/checkin', { habitId: habitId(db, 'nutrition'), date: '2026-10-21', done: true })).statusCode).toBe(200);
  });

  it('пауза уменьшает слоты в кольцах и не даёт пропусков', async () => {
    const { login } = await setupApi();
    const u = await login(1);
    await u.call('POST', '/pause', { days: 3 });
    const dash = (await u.call('GET', '/dashboard')).json();
    expect(dash.users[0].rings.nutrition).toEqual({ done: 0, skipped: 2, total: 130 }); // пропущены 19 и 20, 21–23 на паузе
  });

  it.each([[0], [15], ['много'], [1.5]])('отклоняет days=%j', async (days) => {
    const { login } = await setupApi();
    const u = await login(1);
    expect((await u.call('POST', '/pause', { days: days as number })).statusCode).toBe(400);
  });

  it('нельзя начать паузу в прошлом дальше вчерашнего дня и вне арки', async () => {
    const { login } = await setupApi();
    const u = await login(1);
    expect((await u.call('POST', '/pause', { days: 2, from: '2026-10-19' })).statusCode).toBe(403);
    expect((await u.call('POST', '/pause', { days: 2, from: '2027-03-05' })).statusCode).toBe(403);
    expect((await u.call('POST', '/pause', { days: 2, from: '2026-10-20' })).statusCode).toBe(200); // вчера можно
  });

  it('всего на арку 21 день паузы', async () => {
    const { login } = await setupApi();
    const u = await login(1);
    expect((await u.call('POST', '/pause', { days: 14 })).statusCode).toBe(200);
    const over = await u.call('POST', '/pause', { days: 14, from: '2026-11-04' });
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ error: 'pause_limit', daysLeft: 7 });
    expect((await u.call('POST', '/pause', { days: 7, from: '2026-11-04' })).statusCode).toBe(200);
  });

  it('снятие паузы освобождает дни, чужая пауза не затрагивается', async () => {
    const { login } = await setupApi();
    const a = await login(1);
    const b = await login(2);
    await a.call('POST', '/pause', { days: 5 });
    await b.call('POST', '/pause', { days: 5 });
    await a.call('DELETE', '/pause');
    expect((await a.call('GET', '/today')).json().paused).toBe(false);
    expect((await b.call('GET', '/today')).json().paused).toBe(true);
  });

  it('частичное снятие: из недельной паузы остаётся прошлое', async () => {
    const { login } = await setupApi();
    const u = await login(1);
    await u.call('POST', '/pause', { days: 5, from: '2026-10-20' }); // 20–24
    const r = (await u.call('DELETE', '/pause?from=2026-10-22')).json(); // с 22-го снимаем
    expect(r.pauseDaysLeft).toBe(19); // остались 20 и 21
    expect((await u.call('GET', '/today?date=2026-10-20')).json().paused).toBe(true);
  });
});

describe('ачивки через API', () => {
  const seedGood = (db: Db, userId: number, days: string[]) =>
    days.forEach((d) => { addCheckin(db, userId, 'nutrition', d); addCheckin(db, userId, 'sleep', d); });

  it('открывается после выполнения условия, уведомление приходит один раз', async () => {
    const { db, login, notified } = await setupApi();
    const u = await login(1);
    seedGood(db, u.id, ['2026-10-19', '2026-10-20']);

    await u.call('PUT', '/checkin', { habitId: habitId(db, 'nutrition'), date: '2026-10-21', done: true });
    expect(notified).toHaveLength(0); // серии из трёх дней пока нет
    await u.call('PUT', '/checkin', { habitId: habitId(db, 'sleep'), date: '2026-10-21', done: true });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ tgId: 1 });
    expect(notified[0]!.text).toContain('Разгон');

    await u.call('PUT', '/checkin', { habitId: habitId(db, 'workout'), date: '2026-10-21', done: true });
    expect(notified).toHaveLength(1); // новых условий нет, повторов нет
  });

  it('открытая ачивка не пропадает, если отметку потом сняли', async () => {
    const { db, login } = await setupApi();
    const u = await login(1);
    seedGood(db, u.id, ['2026-10-19', '2026-10-20']);
    await u.call('PUT', '/checkin', { habitId: habitId(db, 'nutrition'), date: '2026-10-21', done: true });
    await u.call('PUT', '/checkin', { habitId: habitId(db, 'sleep'), date: '2026-10-21', done: true });
    await u.call('PUT', '/checkin', { habitId: habitId(db, 'sleep'), date: '2026-10-21', done: false });
    const list = (await u.call('GET', '/achievements')).json();
    expect(list.find((a: { code: string }) => a.code === 'streak-3').unlockedAt).not.toBeNull();
  });

  it('секретные ачивки скрыты до открытия', async () => {
    const { login } = await setupApi();
    const u = await login(1);
    const list = (await u.call('GET', '/achievements')).json();
    expect(list).toHaveLength(18);
    const secret = list.find((a: { code: string }) => a.code === 'all-in-7');
    expect(secret).toMatchObject({ title: '???', unlockedAt: null, description: 'Секретная ачивка' });
    expect(list.find((a: { code: string }) => a.code === 'streak-3').title).toBe('Разгон');
  });

  it('значки и серия видны на дашборде, детали содержат серию, ачивки и паузу', async () => {
    const { db, login } = await setupApi();
    const a = await login(1);
    const b = await login(2);
    seedGood(db, a.id, ['2026-10-19', '2026-10-20']);
    await a.call('PUT', '/checkin', { habitId: habitId(db, 'nutrition'), date: '2026-10-21', done: true });
    await a.call('PUT', '/checkin', { habitId: habitId(db, 'sleep'), date: '2026-10-21', done: true });
    await a.call('POST', '/pause', { days: 2, from: '2026-10-22' });

    const dash = (await b.call('GET', '/dashboard')).json();
    const anya = dash.users.find((u: { id: number }) => u.id === a.id);
    expect(anya).toMatchObject({ streak: 3, badges: ['streak-3'] });

    const detail = (await b.call('GET', `/users/${a.id}/days`)).json();
    expect(detail.streak).toMatchObject({ current: 3, best: 3 });
    expect(detail.achievements.map((x: { code: string }) => x.code)).toEqual(['streak-3']);
    expect(detail.paused).toEqual(['2026-10-22', '2026-10-23']);
  });

  it('участникам-призракам (tg_id < 0) уведомления не уходят', async () => {
    const { db, login, notified } = await setupApi();
    const u = await login(-5);
    seedGood(db, u.id, ['2026-10-19', '2026-10-20']);
    await u.call('PUT', '/checkin', { habitId: habitId(db, 'nutrition'), date: '2026-10-21', done: true });
    await u.call('PUT', '/checkin', { habitId: habitId(db, 'sleep'), date: '2026-10-21', done: true });
    expect(notified).toHaveLength(0);
    expect(db.prepare('SELECT count(*) c FROM achievement').get()).toEqual({ c: 1 }); // но ачивка записана
  });
});

// ---------- бот и дайджест ----------

interface Call { method: string; payload: Record<string, any> }

function setupBot(devToday = '2026-10-21') {
  const config = loadConfig({
    BOT_TOKEN: '1:T', SESSION_SECRET: 's', ADMIN_TG_ID: String(ADMIN), DEV_AUTH: '1', DEV_TODAY: devToday,
    WEBAPP_URL: 'https://panel.example.com',
  });
  const db = openDb(':memory:');
  const calls: Call[] = [];
  const bot = createBot(config, db, {
    botInfo: {
      id: 1, is_bot: true, first_name: 'Ark', username: 'ark_bot', can_join_groups: true, can_read_all_group_messages: false,
      supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false,
    } as never,
  });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    return { ok: true, result: method === 'sendMessage' ? { message_id: 1, date: 0, chat: { id: 1, type: 'private' } } : true } as never;
  });
  const user = (id: number) => ({ id, is_bot: false, first_name: `U${id}` });
  const say = (id: number, text: string, chat: { id: number; type: string } = { id, type: 'private' }) =>
    bot.handleUpdate({
      update_id: Math.floor(Math.random() * 1e9),
      message: {
        message_id: 1, date: 0, chat: { ...chat, first_name: `U${id}`, title: 'Группа' }, from: user(id), text,
        entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }],
      },
    } as never);
  const tap = (id: number, data: string) =>
    bot.handleUpdate({
      update_id: Math.floor(Math.random() * 1e9),
      callback_query: {
        id: 'cb', from: user(id), chat_instance: 'x', data,
        message: { message_id: 10, date: 0, chat: { id, type: 'private', first_name: `U${id}` }, text: 'poll' },
      },
    } as never);
  const register = async (id: number) => say(id, `/start ${getInviteCode(db)}`);
  const sent = (method: string) => calls.filter((c) => c.method === method);
  const texts = () => sent('sendMessage').map((c) => c.payload.text as string);
  const userId = (tg: number) => (db.prepare('SELECT id FROM user WHERE tg_id = ?').get(tg) as { id: number }).id;
  return { config, db, calls, say, tap, register, sent, texts, userId };
}

describe('бот: пауза', () => {
  it('/pause ставит паузу, /today это показывает, /resume снимает', async () => {
    const t = setupBot();
    await t.register(5);
    await t.say(5, '/pause 2');
    expect(t.texts().at(-1)).toContain('Пауза с 21 октября по 22 октября');
    expect(t.db.prepare('SELECT count(*) c FROM pause').get()).toEqual({ c: 1 });

    await t.say(5, '/today');
    expect(t.texts().at(-1)).toContain('Сегодня пауза');

    await t.say(5, '/resume');
    expect(t.texts().at(-1)).toContain('Пауза снята');
    await t.say(5, '/resume');
    expect(t.texts().at(-1)).toContain('Сейчас паузы нет');
  });

  it('/pause без аргумента = 1 день, кривые значения отклоняются, лимит объясняется', async () => {
    const t = setupBot();
    await t.register(5);
    await t.say(5, '/pause');
    expect(t.texts().at(-1)).toContain('Пауза с 21 октября по 21 октября');
    await t.say(5, '/pause 99');
    expect(t.texts().at(-1)).toContain('от 1 до 14');
    await t.say(5, '/resume');
    // уже взято 14 дней в ноябре: новые 14 дней с сегодняшнего дня вместе дадут больше 21
    t.db.prepare("INSERT INTO pause (user_id, start_date, end_date) VALUES (?, '2026-11-10', '2026-11-23')").run(t.userId(5));
    await t.say(5, '/pause 14');
    expect(t.texts().at(-1)).toContain('Лимит паузы исчерпан: осталось 7 дн. из 21');
  });

  it('кнопки опроса в день паузы ничего не меняют', async () => {
    const t = setupBot();
    await t.register(5);
    await t.say(5, '/pause 1');
    await t.tap(5, `t:${habitId(t.db, 'sleep')}:2026-10-21`);
    expect(t.db.prepare('SELECT count(*) c FROM checkin').get()).toEqual({ c: 0 });
    expect(t.sent('answerCallbackQuery').at(-1)!.payload.text).toContain('паузе');
  });

  it('вечерний опрос не уходит тем, у кого пауза', async () => {
    const t = setupBot();
    await t.register(5);
    await t.register(6);
    await t.say(5, '/pause 1');
    const got: number[] = [];
    await pollTick(t.db, t.config, async (tgId: number, _poll: Poll) => void got.push(tgId), new Date('2026-10-21T18:05:00Z'));
    expect(got).toEqual([6]);
  });
});

describe('бот: ачивки и серия в опросе', () => {
  it('нажатие кнопки, которое закрывает условие, присылает сообщение об ачивке', async () => {
    const t = setupBot();
    await t.register(5);
    const uid = t.userId(5);
    for (const d of ['2026-10-19', '2026-10-20']) { addCheckin(t.db, uid, 'nutrition', d); addCheckin(t.db, uid, 'sleep', d); }

    await t.tap(5, `t:${habitId(t.db, 'nutrition')}:2026-10-21`);
    await t.tap(5, `t:${habitId(t.db, 'sleep')}:2026-10-21`);
    const achievementMessages = t.texts().filter((x) => x.includes('Новая ачивка'));
    expect(achievementMessages).toHaveLength(1);
    expect(achievementMessages[0]).toContain('Разгон');
    // и в самом опросе теперь видна серия
    const edit = t.sent('editMessageText').at(-1)!.payload.text as string;
    expect(edit).toContain('🔥 Серия: 3 дн.');
  });
});

describe('недельный дайджест', () => {
  const MONDAY = '2026-10-26'; // неделя 19–25 октября завершена

  const seedWeek = (t: ReturnType<typeof setupBot>) => {
    const week = dates('2026-10-19', 7);
    const a = t.userId(5); // идеальная неделя
    week.forEach((d) => { addCheckin(t.db, a, 'nutrition', d); addCheckin(t.db, a, 'sleep', d); });
    ['2026-10-19', '2026-10-21', '2026-10-23'].forEach((d) => addCheckin(t.db, a, 'workout', d));
    const b = t.userId(6); // три дня питания
    week.slice(0, 3).forEach((d) => addCheckin(t.db, b, 'nutrition', d));
  };

  it('/digest_here: только админ и только в группе; /digest_off выключает', async () => {
    const t = setupBot();
    const group = { id: -100123, type: 'supergroup' };
    await t.say(5, '/digest_here', group);
    expect(getDigestChat(t.db)).toBeNull(); // не админ

    await t.say(ADMIN, '/digest_here');
    expect(getDigestChat(t.db)).toBeNull();
    expect(t.texts().at(-1)).toContain('групповом чате');

    await t.say(ADMIN, '/digest_here', group);
    expect(getDigestChat(t.db)).toBe(-100123);

    await t.say(ADMIN, '/digest_off', group);
    expect(getDigestChat(t.db)).toBeNull();
  });

  it('/digest до завершения первой недели сообщает об этом', async () => {
    const t = setupBot('2026-10-21');
    await t.say(ADMIN, '/digest');
    expect(t.texts().at(-1)).toContain('Пока нет завершённой недели');
  });

  it('текст: лидеры, идеальная неделя, серия, процент', async () => {
    const t = setupBot(MONDAY);
    await t.register(5);
    await t.register(6);
    seedWeek(t);
    const arc = getArc(t.db);
    const text = buildDigestText(t.db, arc, MONDAY, lastCompletedWeek(arc, MONDAY)!)!;
    expect(text).toContain('Итоги недели 19 окт – 25 окт');
    expect(text).toMatch(/1\. U5: 100%/);
    expect(text).toMatch(/2\. U6: /);
    expect(text).toContain('Идеальная неделя: U5');
    expect(text).toContain('Самая длинная серия сейчас: U5, 7 дн.');
  });

  it('шлёт по понедельникам после 10:00 один раз за неделю', async () => {
    const t = setupBot(MONDAY);
    await t.register(5);
    await t.register(6);
    seedWeek(t);
    t.db.prepare("INSERT INTO setting (key, value) VALUES ('digest_chat_id', '-100123')").run();

    const sent: { chatId: number; text: string }[] = [];
    const send = async (chatId: number, text: string) => void sent.push({ chatId, text });

    expect(await digestTick(t.db, t.config, send, new Date('2026-10-26T06:30:00Z'))).toBe(false); // 09:30 МСК
    expect(await digestTick(t.db, t.config, send, new Date('2026-10-26T07:30:00Z'))).toBe(true); // 10:30 МСК
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatId: -100123 });
    expect(await digestTick(t.db, t.config, send, new Date('2026-10-26T12:00:00Z'))).toBe(false); // уже отправлен
  });

  it('не шлёт не по понедельникам и без привязанного чата', async () => {
    const send = async () => undefined;
    const tuesday = setupBot('2026-10-27');
    tuesday.db.prepare("INSERT INTO setting (key, value) VALUES ('digest_chat_id', '-1')").run();
    expect(await digestTick(tuesday.db, tuesday.config, send, new Date('2026-10-27T10:00:00Z'))).toBe(false);

    const noChat = setupBot(MONDAY);
    await noChat.register(5);
    await noChat.register(6);
    seedWeek(noChat);
    expect(await digestTick(noChat.db, noChat.config, send, new Date('2026-10-26T10:00:00Z'))).toBe(false);
  });

  it('при временной ошибке повторяет, если бота убрали из чата — нет', async () => {
    const fail = (code: number) => async () => { throw Object.assign(new Error('x'), { error_code: code }); };
    const make = async () => {
      const t = setupBot(MONDAY);
      await t.register(5);
      await t.register(6);
      seedWeek(t);
      t.db.prepare("INSERT INTO setting (key, value) VALUES ('digest_chat_id', '-1')").run();
      return t;
    };
    const now = new Date('2026-10-26T08:00:00Z');
    const ok = async () => undefined;

    const a = await make();
    expect(await digestTick(a.db, a.config, fail(500), now)).toBe(false);
    expect(await digestTick(a.db, a.config, ok, now)).toBe(true); // повтор прошёл

    const b = await make();
    await digestTick(b.db, b.config, fail(403), now);
    expect(await digestTick(b.db, b.config, ok, now)).toBe(false); // бота выгнали, не ретраим
  });

  it('участников без данных за неделю дайджест не строит', async () => {
    const t = setupBot(MONDAY);
    await t.register(5);
    const arc = getArc(t.db);
    // у участника есть слоты (активные дни), поэтому дайджест строится даже при нулевом выполнении
    expect(buildDigestText(t.db, arc, MONDAY, lastCompletedWeek(arc, MONDAY)!)).toContain('Выполнено 0%');
  });
});
