import { randomBytes } from 'node:crypto';
import { Bot, InlineKeyboard, type BotConfig, type Context } from 'grammy';
import { isEditable, MAX_PAUSE_REQUEST_DAYS, MAX_PAUSE_TOTAL_DAYS } from '@ark/shared';
import { refreshAndNotify } from './achievements';
import type { Config } from './config';
import type { Db } from './db';
import { buildDigestText, clearDigestChat, lastCompletedWeek, setDigestChat } from './digest';
import { loadPausedDates } from './history';
import { addPause, cancelPause } from './pause';
import { buildPoll, todayOf } from './poll';
import { updateProfile } from './profile';
import { buildToday, currentDate, getArc, isDone, setCheckin, visibleHabit } from './today';
import { getUserByTgId, upsertUser } from './users';

/** Единый код приглашения для группы; создаётся при первом обращении, /newinvite выпускает новый. */
export function getInviteCode(db: Db): string {
  const row = db.prepare("SELECT value FROM setting WHERE key = 'invite_code'").get() as { value: string } | undefined;
  return row?.value ?? rotateInviteCode(db);
}

export function rotateInviteCode(db: Db): string {
  const code = randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO setting (key, value) VALUES ('invite_code', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(code);
  return code;
}

const ruDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

const COMMANDS = [
  { command: 'today', description: 'Опрос за сегодня' },
  { command: 'time', description: 'Время вечернего опроса, например /time 21:30' },
  { command: 'pause', description: 'Пауза на несколько дней, например /pause 3' },
  { command: 'resume', description: 'Снять паузу' },
  { command: 'help', description: 'Что умеет бот' },
];

export function createBot(config: Config, db: Db, botConfig?: BotConfig<Context>) {
  const bot = new Bot(config.botToken || 'unset', botConfig);

  const appKeyboard = () => (config.webAppUrl ? new InlineKeyboard().webApp('Открыть панель', config.webAppUrl) : undefined);
  const isAdmin = (id: number) => config.adminTgId !== null && id === config.adminTgId;

  bot.command('start', async (ctx) => {
    const from = ctx.from;
    if (!from || ctx.chat.type !== 'private') return;
    const payload = ctx.match.trim();
    let user = getUserByTgId(db, from.id, config.adminTgId);
    const welcomeBack = !!user;

    if (!user) {
      if (!isAdmin(from.id) && !(payload && payload === getInviteCode(db))) {
        await ctx.reply('Это закрытая панель. Нужна ссылка-приглашение от организатора.');
        return;
      }
      const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
      user = upsertUser(db, { id: from.id, name, avatarUrl: null }, config.adminTgId);
    }

    await ctx.reply(
      [
        welcomeBack ? `С возвращением, ${user.name}!` : `Добро пожаловать в Winter Arc, ${user.name}!`,
        'Каждый вечер я пришлю опрос с отметками. Время опроса можно поменять командой /time 21:30.',
        config.webAppUrl ? 'Прогресс всех участников смотри в панели.' : '',
      ].filter(Boolean).join('\n'),
      { reply_markup: appKeyboard() },
    );
  });

  bot.command('help', (ctx) =>
    ctx.reply(
      [
        '/today — опрос за сегодня',
        '/time 21:30 — время вечернего опроса',
        `/pause 3 — пауза на несколько дней (болею, в отъезде), до ${MAX_PAUSE_REQUEST_DAYS}`,
        '/resume — снять паузу',
        ...(isAdmin(ctx.from?.id ?? 0)
          ? ['/invite — ссылка-приглашение', '/newinvite — выпустить новую ссылку', '/digest_here — в группе: присылать сюда недельный дайджест', '/digest_off — выключить дайджест', '/digest — показать дайджест за прошлую неделю']
          : []),
      ].join('\n'),
    ),
  );

  bot.command('today', async (ctx) => {
    const today = ctx.from && todayOf(db, config, ctx.from.id);
    if (!today) return ctx.reply('Сначала нужна ссылка-приглашение от организатора.');
    if (today.paused) return ctx.reply(`⏸ Сегодня пауза${today.pauseEndsOn ? ` (до ${ruDate(today.pauseEndsOn)})` : ''}. Отметки не нужны. Снять паузу: /resume`);
    const poll = buildPoll(config, today);
    return ctx.reply(poll.text, { reply_markup: poll.markup });
  });

  bot.command('pause', async (ctx) => {
    const user = ctx.from && getUserByTgId(db, ctx.from.id, config.adminTgId);
    if (!user) return ctx.reply('Сначала нужна ссылка-приглашение от организатора.');
    const arg = ctx.match.trim();
    const days = arg === '' ? 1 : Number(arg);
    const arc = getArc(db);
    const today = currentDate(config, arc);
    const r = addPause(db, arc, user.id, today, today, days);
    if (r.ok) {
      refreshAndNotify(db, config, user, notify);
      return ctx.reply(`⏸ Пауза с ${ruDate(r.from)} по ${ruDate(r.to)}. Отметки в эти дни не нужны, серия сохраняется. Осталось дней паузы: ${r.daysLeft}. Снять: /resume`);
    }
    if (r.error === 'invalid_days') return ctx.reply(`Укажи число дней от 1 до ${MAX_PAUSE_REQUEST_DAYS}, например: /pause 3`);
    if (r.error === 'pause_limit') return ctx.reply(`Лимит паузы исчерпан: осталось ${r.daysLeft} дн. из ${MAX_PAUSE_TOTAL_DAYS}. Попробуй меньше дней.`);
    return ctx.reply('Паузу можно начать только сегодня или вчера, и только внутри арки.');
  });

  bot.command('resume', async (ctx) => {
    const user = ctx.from && getUserByTgId(db, ctx.from.id, config.adminTgId);
    if (!user) return ctx.reply('Сначала нужна ссылка-приглашение от организатора.');
    const arc = getArc(db);
    const today = currentDate(config, arc);
    const freed = cancelPause(db, arc, user.id, today, today);
    return ctx.reply(freed === 'out_of_window' || freed === 0 ? 'Сейчас паузы нет.' : `Пауза снята, вернули ${freed} дн. Хорошего продолжения!`);
  });

  bot.command('time', async (ctx) => {
    const user = ctx.from && getUserByTgId(db, ctx.from.id, config.adminTgId);
    if (!user) return ctx.reply('Сначала нужна ссылка-приглашение от организатора.');
    const m = /^(\d{1,2}):(\d{2})$/.exec(ctx.match.trim());
    const hhmm = m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : '';
    if (!m || updateProfile(db, user.id, { pollTime: hhmm })) {
      return ctx.reply(`Сейчас опрос приходит в ${user.pollTime}. Чтобы поменять, напиши, например: /time 21:30`);
    }
    return ctx.reply(`Готово, опрос будет приходить в ${hhmm} по Москве.`);
  });

  const sendInvite = async (ctx: Context, code: string) => {
    const username = bot.botInfo.username;
    await ctx.reply(`Ссылка-приглашение:\nhttps://t.me/${username}?start=${code}`);
  };

  bot.command('invite', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await sendInvite(ctx, getInviteCode(db));
  });

  bot.command('newinvite', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.reply('Старая ссылка больше не работает. Уже зарегистрированные участники остаются.');
    await sendInvite(ctx, rotateInviteCode(db));
  });

  // Недельный дайджест в групповой чат (только админ)
  bot.command('digest_here', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
      return ctx.reply('Эту команду нужно отправить в групповом чате, куда добавлен бот.');
    }
    setDigestChat(db, ctx.chat.id);
    return ctx.reply('Готово: итоги недели будут приходить сюда по понедельникам в 10:00 по Москве.');
  });

  bot.command('digest_off', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    clearDigestChat(db);
    return ctx.reply('Недельный дайджест выключен.');
  });

  bot.command('digest', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    const arc = getArc(db);
    const today = currentDate(config, arc);
    const week = lastCompletedWeek(arc, today);
    const text = week && buildDigestText(db, arc, today, week);
    return ctx.reply(text || 'Пока нет завершённой недели с данными.');
  });

  const notify = (tgId: number, text: string) => bot.api.sendMessage(tgId, text).then(() => undefined);

  // Кнопки опроса: t:<habitId>:<date>
  bot.callbackQuery(/^t:(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const user = getUserByTgId(db, ctx.from.id, config.adminTgId);
    if (!user) return ctx.answerCallbackQuery({ text: 'Сначала нужна ссылка-приглашение.' });

    const habitId = Number(ctx.match[1]);
    const date = ctx.match[2]!;
    const arc = getArc(db);
    const today = currentDate(config, arc);

    if (!isEditable(date, today, arc)) {
      return ctx.answerCallbackQuery({ text: 'Этот день уже нельзя править.' });
    }
    if (!visibleHabit(db, habitId, user.id)) {
      return ctx.answerCallbackQuery({ text: 'Такого пункта больше нет.' });
    }

    if (loadPausedDates(db, arc, user.id).get(user.id)?.has(date)) {
      return ctx.answerCallbackQuery({ text: 'День на паузе. Снять паузу: /resume' });
    }

    setCheckin(db, user.id, habitId, date, !isDone(db, user.id, habitId, date));
    refreshAndNotify(db, config, user, notify);
    const poll = buildPoll(config, buildToday(db, user, date, today, arc));
    await ctx.editMessageText(poll.text, { reply_markup: poll.markup }).catch(() => undefined);
    return ctx.answerCallbackQuery();
  });

  bot.catch((err) => console.error('bot error:', err.error));
  return bot;
}

/** Запускает long polling и выставляет команды и кнопку меню. */
export async function startBot(bot: Bot, config: Config): Promise<void> {
  await bot.api.setMyCommands(COMMANDS);
  if (config.webAppUrl) {
    await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Панель', web_app: { url: config.webAppUrl } } });
  }
  void bot.start({ onStart: (me) => console.log(`bot @${me.username} started`) });
}
