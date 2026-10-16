import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createBot, getInviteCode, rotateInviteCode } from '../src/bot';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';
import { pollTick, type Poll } from '../src/poll';

const ADMIN = 100;
const TODAY = '2026-10-21'; // ср, день 3 арки

interface Call { method: string; payload: Record<string, any> }

function setup(env: Record<string, string> = {}) {
  const config = loadConfig({
    BOT_TOKEN: '1:T', SESSION_SECRET: 's', ADMIN_TG_ID: String(ADMIN), DEV_AUTH: '1', DEV_TODAY: TODAY,
    WEBAPP_URL: 'https://panel.example.com', ...env,
  });
  const db = openDb(':memory:');
  const calls: Call[] = [];
  const bot = createBot(config, db, {
    botInfo: {
      id: 1, is_bot: true, first_name: 'Ark', username: 'ark_bot', can_join_groups: false,
      can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
      has_main_web_app: false,
    } as never,
  });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    return { ok: true, result: method === 'sendMessage' ? { message_id: 1, date: 0, chat: { id: 1, type: 'private' } } : true } as never;
  });

  const user = (id: number, name = `U${id}`) => ({ id, is_bot: false, first_name: name });
  const say = (id: number, text: string) =>
    bot.handleUpdate({
      update_id: Math.floor(Math.random() * 1e9),
      message: {
        message_id: 1, date: 0, chat: { id, type: 'private', first_name: `U${id}` }, from: user(id), text,
        entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : [],
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
  const sent = (method: string) => calls.filter((c) => c.method === method);
  const lastText = () => sent('sendMessage').at(-1)?.payload.text as string | undefined;
  return { config, db, bot, calls, say, tap, sent, lastText };
}

const users = (db: ReturnType<typeof openDb>) => db.prepare('SELECT tg_id FROM user').all();

describe('регистрация по приглашению', () => {
  it('принимает с правильным кодом и создаёт участника', async () => {
    const t = setup();
    await t.say(5, `/start ${getInviteCode(t.db)}`);
    expect(users(t.db)).toEqual([{ tg_id: 5 }]);
    expect(t.lastText()).toContain('Добро пожаловать');
    expect(t.sent('sendMessage')[0]!.payload.reply_markup.inline_keyboard[0][0].web_app.url).toBe('https://panel.example.com');
  });
  it('отказывает без кода и с неверным кодом', async () => {
    const t = setup();
    await t.say(5, '/start');
    await t.say(6, '/start wrong-code');
    expect(users(t.db)).toEqual([]);
    expect(t.lastText()).toContain('закрытая');
  });
  it('админ регистрируется без кода', async () => {
    const t = setup();
    await t.say(ADMIN, '/start');
    expect(users(t.db)).toEqual([{ tg_id: ADMIN }]);
  });
  it('уже зарегистрированного приветствует заново', async () => {
    const t = setup();
    await t.say(5, `/start ${getInviteCode(t.db)}`);
    await t.say(5, '/start');
    expect(t.lastText()).toContain('С возвращением');
  });
  it('/invite только для админа, /newinvite отзывает старую ссылку', async () => {
    const t = setup();
    await t.say(5, '/invite');
    expect(t.sent('sendMessage')).toHaveLength(0);

    await t.say(ADMIN, '/invite');
    const old = getInviteCode(t.db);
    expect(t.lastText()).toBe(`Ссылка-приглашение:\nhttps://t.me/ark_bot?start=${old}`);

    await t.say(ADMIN, '/newinvite');
    expect(getInviteCode(t.db)).not.toBe(old);
    await t.say(7, `/start ${old}`);
    expect(users(t.db)).toEqual([]);
  });
});

describe('/time', () => {
  it('меняет время опроса и нормализует формат', async () => {
    const t = setup();
    await t.say(5, `/start ${getInviteCode(t.db)}`);
    await t.say(5, '/time 9:30');
    expect(t.db.prepare('SELECT poll_time FROM user').get()).toEqual({ poll_time: '09:30' });
    await t.say(5, '/time 25:00');
    expect(t.db.prepare('SELECT poll_time FROM user').get()).toEqual({ poll_time: '09:30' });
    expect(t.lastText()).toContain('Сейчас опрос приходит в 09:30');
  });
});

describe('кнопки опроса', () => {
  const habitId = (t: ReturnType<typeof setup>, kind: string) =>
    (t.db.prepare('SELECT id FROM habit WHERE kind = ? AND owner_id IS NULL').get(kind) as { id: number }).id;
  const checkins = (t: ReturnType<typeof setup>) => t.db.prepare('SELECT count(*) c FROM checkin').get();

  it('/today присылает опрос с тремя кнопками', async () => {
    const t = setup();
    await t.say(5, `/start ${getInviteCode(t.db)}`);
    await t.say(5, '/today');
    const kb = t.sent('sendMessage').at(-1)!.payload.reply_markup.inline_keyboard;
    expect(kb.slice(0, 3).map((r: any[]) => r[0].text)).toEqual(['⬜ Питание', '⬜ Тренировка', '⬜ Сон']);
    expect(kb.slice(0, 3).map((r: any[]) => r[0].callback_data)[0]).toBe(`t:${habitId(t, 'nutrition')}:${TODAY}`);
    expect(t.lastText()).toContain('Тренировок за неделю: 0 из 3');
  });

  it('нажатие ставит отметку, повторное снимает, сообщение обновляется', async () => {
    const t = setup();
    await t.say(5, `/start ${getInviteCode(t.db)}`);
    const data = `t:${habitId(t, 'workout')}:${TODAY}`;

    await t.tap(5, data);
    expect(checkins(t)).toEqual({ c: 1 });
    const edit = t.sent('editMessageText').at(-1)!.payload;
    expect(edit.reply_markup.inline_keyboard[1][0].text).toBe('✅ Тренировка');
    expect(edit.text).toContain('Тренировок за неделю: 1 из 3');
    expect(t.sent('answerCallbackQuery')).toHaveLength(1);

    await t.tap(5, data);
    expect(checkins(t)).toEqual({ c: 0 });
  });

  it('не правит позавчера и чужие данные', async () => {
    const t = setup();
    await t.say(5, `/start ${getInviteCode(t.db)}`);
    await t.tap(5, `t:${habitId(t, 'sleep')}:2026-10-19`); // позавчера
    expect(checkins(t)).toEqual({ c: 0 });
    expect(t.sent('answerCallbackQuery').at(-1)!.payload.text).toContain('нельзя править');

    await t.tap(9, `t:${habitId(t, 'sleep')}:${TODAY}`); // не участник
    expect(checkins(t)).toEqual({ c: 0 });

    // чужой личный пункт
    await t.say(6, `/start ${getInviteCode(t.db)}`);
    const mine = t.db.prepare("INSERT INTO habit (kind, owner_id, title) VALUES ('custom', (SELECT id FROM user WHERE tg_id = 6), 'Шаги')").run();
    await t.tap(5, `t:${mine.lastInsertRowid}:${TODAY}`);
    expect(checkins(t)).toEqual({ c: 0 });
  });
});

describe('вечерняя рассылка', () => {
  const run = async (t: ReturnType<typeof setup>, iso: string) => {
    const sent: { tgId: number; poll: Poll }[] = [];
    const n = await pollTick(t.db, t.config, async (tgId, poll) => void sent.push({ tgId, poll }), new Date(iso));
    return { n, sent };
  };
  const addUser = async (t: ReturnType<typeof setup>, id: number, pollTime = '21:00') => {
    await t.say(id, `/start ${getInviteCode(t.db)}`);
    t.db.prepare('UPDATE user SET poll_time = ? WHERE tg_id = ?').run(pollTime, id);
  };

  it('шлёт в личное время, один раз в сутки', async () => {
    const t = setup();
    await addUser(t, 5, '21:00');
    expect((await run(t, '2026-10-21T17:59:00Z')).n).toBe(0); // 20:59 МСК — рано
    const at = await run(t, '2026-10-21T18:05:00Z'); // 21:05 МСК
    expect(at.n).toBe(1);
    expect(at.sent[0]!.tgId).toBe(5);
    expect((await run(t, '2026-10-21T18:06:00Z')).n).toBe(0); // уже отправлено
  });
  it('у каждого своё время', async () => {
    const t = setup();
    await addUser(t, 5, '21:00');
    await addUser(t, 6, '22:30');
    expect((await run(t, '2026-10-21T18:05:00Z')).sent.map((s) => s.tgId)).toEqual([5]);
    expect((await run(t, '2026-10-21T19:35:00Z')).sent.map((s) => s.tgId)).toEqual([6]); // 22:35 МСК
  });
  it('не шлёт, если окно в 2 часа прошло', async () => {
    const t = setup();
    await addUser(t, 5, '21:00');
    expect((await run(t, '2026-10-21T20:30:00Z')).n).toBe(0); // 23:30 МСК
  });
  it('не шлёт вне арки и выдуманным участникам', async () => {
    const t = setup({ DEV_TODAY: '2026-10-15' });
    await addUser(t, 5);
    expect((await run(t, '2026-10-15T18:05:00Z')).n).toBe(0);

    const t2 = setup();
    t2.db.prepare("INSERT INTO user (tg_id, name, poll_time) VALUES (-1, 'Выдуманный', '21:00')").run();
    expect((await run(t2, '2026-10-21T18:05:00Z')).n).toBe(0);
  });
  it('при временной ошибке повторяет, при блокировке бота — нет', async () => {
    const t = setup();
    await addUser(t, 5);
    const fail = (code: number) => async () => { throw Object.assign(new Error('x'), { error_code: code }); };
    const now = new Date('2026-10-21T18:05:00Z');
    await pollTick(t.db, t.config, fail(500), now);
    expect((await run(t, '2026-10-21T18:06:00Z')).n).toBe(1); // повтор прошёл

    const t2 = setup();
    await addUser(t2, 5);
    await pollTick(t2.db, t2.config, fail(403), now);
    expect((await run(t2, '2026-10-21T18:06:00Z')).n).toBe(0); // заблокировал — не ретраим

    const t3 = setup();
    await addUser(t3, 5);
    await pollTick(t3.db, t3.config, fail(400), now); // chat not found
    expect((await run(t3, '2026-10-21T18:06:00Z')).n).toBe(0);
  });
  it('в опросе уже учтены сегодняшние отметки', async () => {
    const t = setup();
    await addUser(t, 5);
    const sleep = (t.db.prepare("SELECT id FROM habit WHERE kind = 'sleep'").get() as { id: number }).id;
    await t.tap(5, `t:${sleep}:${TODAY}`);
    const { sent } = await run(t, '2026-10-21T18:05:00Z');
    expect((sent[0]!.poll.markup.inline_keyboard[2]![0] as { text: string }).text).toBe('✅ Сон');
  });
});

describe('вход в Mini App', () => {
  const signed = (id: number) => {
    const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: 'X' }) };
    const dcs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = createHmac('sha256', 'WebAppData').update('1:T').digest();
    return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(dcs).digest('hex') }).toString();
  };
  const auth = async (t: ReturnType<typeof setup>, id: number) => {
    const app = await buildApp(t.config, t.db);
    return app.inject({ method: 'POST', url: '/auth', payload: { initData: signed(id) } });
  };

  it('не приглашённого не пускает', async () => {
    const t = setup();
    expect((await auth(t, 5)).statusCode).toBe(403);
    expect(users(t.db)).toEqual([]);
  });
  it('зарегистрированного ботом и админа пускает', async () => {
    const t = setup();
    await t.say(5, `/start ${getInviteCode(t.db)}`);
    expect((await auth(t, 5)).statusCode).toBe(200);
    expect((await auth(t, ADMIN)).statusCode).toBe(200);
  });
  it('код приглашения стабилен, пока его не обновили', () => {
    const t = setup();
    expect(getInviteCode(t.db)).toBe(getInviteCode(t.db));
    expect(rotateInviteCode(t.db)).not.toBe('');
  });
});
