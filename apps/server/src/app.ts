import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import {
  ACHIEVEMENTS,
  isDateStr,
  isValidHabitSpec,
  isEditable,
  MAX_CUSTOM_HABITS,
  MAX_HABIT_TITLE,
  type AchievementView,
  type AuthResponse,
  type UserProfile,
} from '@ark/shared';
import { refreshAndNotify, unlockedOf, type Notify } from './achievements';
import type { Config } from './config';
import type { Db } from './db';
import { buildDashboard, buildUserDetail } from './dashboard';
import { loadPausedDates } from './history';
import { addPause, cancelPause } from './pause';
import { updateProfile } from './profile';
import { validateInitData } from './telegramAuth';
import { buildToday, currentDate, getArc, setCheckin, visibleHabit } from './today';
import { getUserByTgId, upsertUser } from './users';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { tgId: number };
    user: { tgId: number };
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    profile: UserProfile;
  }
}

export interface AppDeps {
  /** Отправка личных сообщений участникам (ачивки); без бота уведомлений нет */
  notify?: Notify;
}

export async function buildApp(config: Config, db: Db, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.VITEST ? false : { level: 'info' } });
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
  await app.register(jwt, { secret: config.sessionSecret, sign: { expiresIn: '7d' } });

  app.get('/health', async () => ({ ok: true }));

  app.post<{ Body: { initData?: string; dev?: { id: number; name: string } } }>(
    '/auth',
    async (req, reply) => {
      const { initData, dev } = req.body ?? {};
      let tg: { id: number; name: string; avatarUrl: string | null } | null = null;

      if (initData) {
        const data = validateInitData(initData, config.botToken);
        if (data) {
          const u = data.user;
          tg = {
            id: u.id,
            name: [u.first_name, u.last_name].filter(Boolean).join(' '),
            avatarUrl: u.photo_url ?? null,
          };
        }
      } else if (config.devAuth && dev && Number.isInteger(dev.id) && dev.name) {
        tg = { id: dev.id, name: dev.name, avatarUrl: null };
      }
      if (!tg) return reply.code(401).send({ error: 'invalid_init_data' });

      // Через Telegram входят только приглашённые (они зарегистрированы ботом) и админ.
      // dev-вход без Telegram проходит только при DEV_AUTH=1.
      if (initData && tg.id !== config.adminTgId && !getUserByTgId(db, tg.id, config.adminTgId)) {
        return reply.code(403).send({ error: 'not_invited' });
      }

      const user = upsertUser(db, tg, config.adminTgId);
      const token = app.jwt.sign({ tgId: user.tgId });
      const body: AuthResponse = { token, user };
      return body;
    },
  );

  await app.register(async (api) => {
    api.decorateRequest('profile', null as unknown as UserProfile);
    api.addHook('onRequest', async (req, reply) => {
      try {
        await req.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const profile = getUserByTgId(db, req.user.tgId, config.adminTgId);
      if (!profile) return reply.code(401).send({ error: 'unauthorized' });
      req.profile = profile;
    });

    const reload = (req: { profile: UserProfile }) =>
      getUserByTgId(db, req.profile.tgId, config.adminTgId)!;

    api.get('/me', async (req) => req.profile);

    api.put('/me', async (req, reply) => {
      const error = updateProfile(db, req.profile.id, req.body);
      if (error) return reply.code(400).send({ error });
      return reload(req);
    });

    api.get<{ Querystring: { date?: string } }>('/today', async (req, reply) => {
      const arc = getArc(db);
      const today = currentDate(config, arc);
      const date = req.query.date ?? today;
      if (!isDateStr(date)) return reply.code(400).send({ error: 'invalid_date' });
      return buildToday(db, req.profile, date, today, arc);
    });

    api.put<{ Body: { habitId?: number; date?: string; done?: boolean } }>('/checkin', async (req, reply) => {
      const { habitId, date, done } = req.body ?? {};
      if (!Number.isInteger(habitId) || !isDateStr(date) || typeof done !== 'boolean') {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      const arc = getArc(db);
      const today = currentDate(config, arc);
      if (!isEditable(date, today, arc)) return reply.code(403).send({ error: 'date_not_editable' });
      if (!visibleHabit(db, habitId!, req.profile.id)) return reply.code(404).send({ error: 'habit_not_found' });
      if (loadPausedDates(db, arc, req.profile.id).get(req.profile.id)?.has(date!)) {
        return reply.code(409).send({ error: 'day_paused' });
      }

      setCheckin(db, req.profile.id, habitId!, date!, done);
      refreshAndNotify(db, config, req.profile, deps.notify);
      return buildToday(db, req.profile, date!, today, arc);
    });

    api.post<{ Body: { days?: number; from?: string } }>('/pause', async (req, reply) => {
      const arc = getArc(db);
      const today = currentDate(config, arc);
      const from = req.body?.from ?? today;
      if (!isDateStr(from)) return reply.code(400).send({ error: 'invalid_date' });
      const result = addPause(db, arc, req.profile.id, today, from, req.body?.days as number);
      if (!result.ok) {
        const status = { invalid_days: 400, out_of_window: 403, pause_limit: 409 }[result.error];
        return reply.code(status).send({ error: result.error, daysLeft: result.daysLeft });
      }
      refreshAndNotify(db, config, req.profile, deps.notify);
      return buildToday(db, req.profile, today, today, arc);
    });

    api.delete<{ Querystring: { from?: string } }>('/pause', async (req, reply) => {
      const arc = getArc(db);
      const today = currentDate(config, arc);
      const from = req.query.from ?? today;
      if (!isDateStr(from)) return reply.code(400).send({ error: 'invalid_date' });
      if (cancelPause(db, arc, req.profile.id, today, from) === 'out_of_window') {
        return reply.code(403).send({ error: 'out_of_window' });
      }
      return buildToday(db, req.profile, today, today, arc);
    });

    api.get('/achievements', async (req): Promise<AchievementView[]> => {
      const unlocked = new Map(unlockedOf(db, req.profile.id).map((a) => [a.code, a.unlockedAt]));
      return ACHIEVEMENTS.map((a) => {
        const unlockedAt = unlocked.get(a.code) ?? null;
        // секретные ачивки не раскрываются, пока не открыты
        return a.hidden && !unlockedAt
          ? { code: a.code, icon: '❔', title: '???', description: 'Секретная ачивка', hidden: true, unlockedAt }
          : { ...a, unlockedAt };
      });
    });

    api.get('/dashboard', async () => {
      const arc = getArc(db);
      return buildDashboard(db, arc, currentDate(config, arc));
    });

    api.get<{ Params: { id: string } }>('/users/:id/days', async (req, reply) => {
      const arc = getArc(db);
      const detail = buildUserDetail(db, arc, currentDate(config, arc), Number(req.params.id));
      if (!detail) return reply.code(404).send({ error: 'user_not_found' });
      return detail;
    });

    api.post<{ Body: { title?: string; type?: string; target?: number } }>('/habits', async (req, reply) => {
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      if (title.length < 1 || title.length > MAX_HABIT_TITLE) return reply.code(400).send({ error: 'invalid_title' });
      const type = req.body?.type ?? 'daily';
      const target = req.body?.target ?? null;
      if (!isValidHabitSpec(type, target)) return reply.code(400).send({ error: 'invalid_habit_type' });
      const { c } = db
        .prepare("SELECT count(*) AS c FROM habit WHERE owner_id = ? AND kind = 'custom'")
        .get(req.profile.id) as { c: number };
      if (c >= MAX_CUSTOM_HABITS) return reply.code(409).send({ error: 'too_many_habits' });
      const arc = getArc(db);
      const info = db
        .prepare("INSERT INTO habit (kind, owner_id, title, type, target, created_at) VALUES ('custom', ?, ?, ?, ?, ?)")
        .run(req.profile.id, title, type, target, currentDate(config, arc));
      return reply.code(201).send({
        id: Number(info.lastInsertRowid), kind: 'custom', title, done: false, type, target, progress: null,
      });
    });

    api.delete<{ Params: { id: string } }>('/habits/:id', async (req, reply) => {
      const info = db
        .prepare("DELETE FROM habit WHERE id = ? AND owner_id = ? AND kind = 'custom'")
        .run(Number(req.params.id), req.profile.id);
      if (info.changes === 0) return reply.code(404).send({ error: 'habit_not_found' });
      return reply.code(204).send();
    });
  });

  return app;
}
