import { describe, expect, it } from 'vitest';
import { addDays, dailyRing, overall, workoutRing, workoutWeeks } from '@ark/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';

const ARC = { startDate: '2026-10-19', endDate: '2027-02-28' }; // пн … вс, 19 полных недель

describe('dailyRing', () => {
  it('до старта арки всё впереди', () => {
    expect(dailyRing(ARC, '2026-10-15', [])).toEqual({ done: 0, skipped: 0, total: 133 });
  });
  it('в первый день ничего не пропущено', () => {
    expect(dailyRing(ARC, '2026-10-19', [])).toEqual({ done: 0, skipped: 0, total: 133 });
  });
  it('день без отметки пропущен, только когда он раньше сегодня', () => {
    // сегодня 22.10: прошли 19, 20, 21; отмечены 19 и сегодняшний 22
    const r = dailyRing(ARC, '2026-10-22', ['2026-10-19', '2026-10-22']);
    expect(r).toEqual({ done: 2, skipped: 2, total: 133 });
  });
  it('после конца арки будущего нет', () => {
    const r = dailyRing(ARC, '2027-03-10', ['2026-10-19']);
    expect(r.done + r.skipped).toBe(133);
    expect(r.done).toBe(1);
  });
});

describe('workoutRing', () => {
  it('цель за 19 недель = 19 × N', () => {
    expect(workoutRing(ARC, '2026-10-15', [], 3).total).toBe(57);
  });
  it('текущая неделя не даёт пропусков', () => {
    // сегодня ср 21.10, 0 тренировок
    expect(workoutRing(ARC, '2026-10-21', [], 3)).toEqual({ done: 0, skipped: 0, total: 57 });
  });
  it('закрытая неделя: недовыполнение = пропуск, перевыполнение не копится', () => {
    const done = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']; // 5 при цели 3
    const r = workoutRing(ARC, '2026-10-26', done, 3);
    expect(r).toEqual({ done: 3, skipped: 0, total: 57 });
    expect(workoutRing(ARC, '2026-10-26', ['2026-10-19'], 3)).toEqual({ done: 1, skipped: 2, total: 57 });
  });
  it('неполные недели на краях получают пропорциональную цель', () => {
    const arc = { startDate: '2026-10-21', endDate: '2026-11-03' }; // ср … вт: 5 + 7 + 2 дня
    const weeks = workoutWeeks(arc, '2026-11-10', [], 4);
    expect(weeks.map((w) => w.target)).toEqual([3, 4, 1]); // round(4*5/7), 4, round(4*2/7)
  });
});

describe('overall', () => {
  it('суммирует кольца', () => {
    const z = { done: 1, skipped: 2, total: 10 };
    expect(overall({ nutrition: z, workout: z, sleep: z })).toEqual({ done: 3, skipped: 6, total: 30 });
  });
});

describe('GET /dashboard и /users/:id/days', () => {
  const setup = async () => {
    const config = loadConfig({ SESSION_SECRET: 's', DEV_AUTH: '1', DEV_TODAY: '2026-10-22' });
    const db = openDb(':memory:');
    const app = await buildApp(config, db);
    const login = async (id: number, name: string) => {
      const res = await app.inject({ method: 'POST', url: '/auth', payload: { dev: { id, name } } });
      const headers = { authorization: `Bearer ${res.json().token}` };
      return {
        id: res.json().user.id as number,
        get: (url: string) => app.inject({ method: 'GET', url, headers }),
        post: (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload }),
        check: (habitId: number, date: string) =>
          app.inject({ method: 'PUT', url: '/checkin', headers, payload: { habitId, date, done: true } }),
        today: async () => (await app.inject({ method: 'GET', url: '/today', headers })).json(),
      };
    };
    return { app, login };
  };

  it('401 без токена', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/dashboard' })).statusCode).toBe(401);
  });

  it('показывает всех участников и считает кольца', async () => {
    const { login } = await setup();
    const a = await login(1, 'Аня');
    const b = await login(2, 'Боря');
    const habits = (await a.today()).habits;
    const nutrition = habits.find((h: { kind: string }) => h.kind === 'nutrition').id;
    await a.check(nutrition, '2026-10-22');
    await a.check(nutrition, '2026-10-21');

    const dash = (await b.get('/dashboard')).json();
    expect(dash.users.map((u: { name: string }) => u.name)).toEqual(['Аня', 'Боря']);
    const [anya, borya] = dash.users;
    expect(anya.rings.nutrition).toEqual({ done: 2, skipped: 2, total: 133 }); // пропущены 19 и 20
    expect(borya.rings.nutrition).toEqual({ done: 0, skipped: 3, total: 133 }); // 19, 20, 21 прошли
    expect(anya.rings.sleep.skipped).toBe(3);
  });

  it('детали: дни от свежих к старым, личные пункты владельца видны другим', async () => {
    const { login } = await setup();
    const a = await login(1, 'Аня');
    const b = await login(2, 'Боря');
    const habit = (await a.post('/habits', { title: 'Шаги' })).json();
    await a.check(habit.id, '2026-10-22');

    const d = (await b.get(`/users/${a.id}/days`)).json();
    expect(d.days.map((x: { date: string }) => x.date)).toEqual(['2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19']);
    expect(d.days[0].done).toEqual([habit.id]);
    expect(d.habits.map((h: { title: string }) => h.title)).toContain('Шаги');
    expect(d.weeks).toHaveLength(1);
    expect(addDays(d.weeks[0].weekStart, 0)).toBe('2026-10-19');

    // у Бори личного пункта Ани в списке нет
    expect(((await b.today()).habits as { title: string }[]).map((h) => h.title)).not.toContain('Шаги');
  });

  it('404 для несуществующего участника', async () => {
    const { login } = await setup();
    const a = await login(1, 'Аня');
    expect((await a.get('/users/999/days')).statusCode).toBe(404);
  });
});
