import { randomBytes } from 'node:crypto';
import { Bot, InlineKeyboard, type BotConfig, type Context } from 'grammy';
import { isEditable } from '@ark/shared';
import type { Config } from './config';
import type { Db } from './db';
import { pollFor, buildPoll } from './poll';
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

const COMMANDS = [
  { command: 'today', description: 'Опрос за сегодня' },
  { command: 'time', description: 'Время вечернего опроса, например /time 21:30' },
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
    ctx.reply('/today — опрос за сегодня\n/time 21:30 — время вечернего опроса\n' + (isAdmin(ctx.from?.id ?? 0) ? '/invite — ссылка-приглашение\n/newinvite — выпустить новую ссылку' : '')),
  );

  bot.command('today', async (ctx) => {
    const poll = ctx.from && pollFor(db, config, ctx.from.id);
    if (!poll) return ctx.reply('Сначала нужна ссылка-приглашение от организатора.');
    return ctx.reply(poll.text, { reply_markup: poll.markup });
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

    setCheckin(db, user.id, habitId, date, !isDone(db, user.id, habitId, date));
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
