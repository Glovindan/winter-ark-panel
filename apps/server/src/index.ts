import { InputFile } from 'grammy';
import { startAchievementScheduler, type Notify } from './achievements';
import { buildApp } from './app';
import { startBackupScheduler, type SendFile } from './backup';
import { createBot, startBot } from './bot';
import { loadConfig } from './config';
import { openDb } from './db';
import { startDigestScheduler } from './digest';
import { startScheduler } from './poll';

const config = loadConfig();
const db = openDb(config.dbPath);
const bot = config.botEnabled ? createBot(config, db) : null;

const notify: Notify | undefined = bot ? async (tgId, text) => void (await bot.api.sendMessage(tgId, text)) : undefined;
const app = await buildApp(config, db, { notify });
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`server listening on :${config.port}`);

const stoppers: (() => void | Promise<void>)[] = [];
let sendBackup: SendFile = async () => undefined; // без бота копии остаются только на диске

if (bot && notify) {
  await startBot(bot, config);
  stoppers.push(
    startScheduler(db, config, async (tgId, poll) => {
      await bot.api.sendMessage(tgId, poll.text, { reply_markup: poll.markup });
    }),
    startAchievementScheduler(db, config, notify),
    startDigestScheduler(db, config, async (chatId, text) => void (await bot.api.sendMessage(chatId, text))),
    () => bot.stop(),
  );
  if (config.adminTgId !== null) {
    const adminId = config.adminTgId;
    sendBackup = async (path, filename) => {
      await bot.api.sendDocument(adminId, new InputFile(path, filename), { caption: 'Ежедневная копия базы' });
    };
  }
} else {
  console.log('бот выключен (нужны BOT_ENABLED=1 и BOT_TOKEN)');
}

stoppers.push(startBackupScheduler(db, config, sendBackup));

const shutdown = async () => {
  for (const stop of stoppers) await stop();
  await app.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
