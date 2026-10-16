import { describe, expect, it } from 'vitest';
import { addDays, arcStat, habitProgress, habitWeeks, isValidHabitSpec, weeklyStat, type HabitSpec } from '@ark/shared';

const ARC = { startDate: '2026-10-19', endDate: '2027-02-28' }; // пн … вс
const weekly = (target: number, createdAt: string | null = '2026-10-19'): HabitSpec => ({ type: 'weekly', target, createdAt });
const set = (...d: string[]) => new Set(d);

describe('isValidHabitSpec', () => {
  it('ежедневный без цели, недельный 1–7, арочный 1–365', () => {
    expect(isValidHabitSpec('daily', undefined)).toBe(true);
    expect(isValidHabitSpec('daily', null)).toBe(true);
    expect(isValidHabitSpec('daily', 3)).toBe(false);
    expect(isValidHabitSpec('weekly', 1)).toBe(true);
    expect(isValidHabitSpec('weekly', 7)).toBe(true);
    expect(isValidHabitSpec('weekly', 0)).toBe(false);
    expect(isValidHabitSpec('weekly', 8)).toBe(false);
    expect(isValidHabitSpec('weekly', 2.5)).toBe(false);
    expect(isValidHabitSpec('weekly', undefined)).toBe(false);
    expect(isValidHabitSpec('arc_total', 365)).toBe(true);
    expect(isValidHabitSpec('arc_total', 366)).toBe(false);
    expect(isValidHabitSpec('arc_total', '10')).toBe(false);
    expect(isValidHabitSpec('monthly', 1)).toBe(false);
  });
});

describe('N раз в неделю', () => {
  it('неделя выполнена, когда набрана норма; открытая неделя ещё не провал', () => {
    const done = set('2026-10-19', '2026-10-21'); // 2 из 2
    const weeks = habitWeeks(ARC, '2026-10-22', weekly(2), done);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]).toMatchObject({ target: 2, done: 2, state: 'met', closed: false });
    expect(habitWeeks(ARC, '2026-10-22', weekly(2), set('2026-10-19'))[0]!.state).toBe('open');
  });

  it('закрытая неделя без нормы — пропуск', () => {
    const weeks = habitWeeks(ARC, '2026-10-27', weekly(2), set('2026-10-19'));
    expect(weeks.map((w) => w.state)).toEqual(['miss', 'open']);
  });

  it('сверх нормы копится: 3 из 2 остаются тремя, неделя выполнена', () => {
    const done = set('2026-10-19', '2026-10-20', '2026-10-21');
    expect(habitWeeks(ARC, '2026-10-26', weekly(2), done)[0]).toMatchObject({ done: 3, target: 2, state: 'met' });
  });

  it('избыток недели не покрывает провал другой недели', () => {
    const done = set('2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'); // 5 за первую, 0 за вторую
    const weeks = habitWeeks(ARC, '2026-11-03', weekly(2), done);
    expect(weeks.map((w) => w.state)).toEqual(['met', 'miss', 'open']);
  });

  it('неделя создания пропорциональна оставшимся дням', () => {
    // создан в четверг 22.10: активны чт–вс = 4 дня, норма 3 в неделю → round(3·4/7) = 2
    const w = habitWeeks(ARC, '2026-10-28', weekly(3, '2026-10-22'), set())[0]!;
    expect(w).toMatchObject({ from: '2026-10-22', activeDays: 4, target: 2 });
  });

  it('создан в воскресенье: слотов нет, неделя нейтральная', () => {
    const w = habitWeeks(ARC, '2026-10-28', weekly(2, '2026-10-25'), set())[0]!;
    expect(w).toMatchObject({ activeDays: 1, target: 0, state: 'skip' });
  });

  it('отметка за день до создания (вчера) учитывается, а не теряется', () => {
    const w = habitWeeks(ARC, '2026-10-22', weekly(2, '2026-10-22'), set('2026-10-21'))[0]!;
    expect(w.from).toBe('2026-10-21');
    expect(w.done).toBe(1);
  });

  it('пауза уменьшает норму; недели целиком на паузе нейтральны и серию не рвут', () => {
    const paused = set(...Array.from({ length: 7 }, (_, i) => addDays('2026-10-26', i)));
    const done = set('2026-10-19', '2026-10-20', '2026-11-02', '2026-11-03');
    const weeks = habitWeeks(ARC, '2026-11-10', weekly(2), done, paused);
    expect(weeks.map((w) => w.state)).toEqual(['met', 'skip', 'met', 'open']);
    expect(weeklyStat(ARC, '2026-11-10', weekly(2), done, paused).streak).toBe(2);
  });

  it('серия недель: открытая неделя не обрывает, закрытый провал обрывает', () => {
    const wk = (ws: string) => [ws, addDays(ws, 1)];
    const done = set(...wk('2026-10-19'), ...wk('2026-10-26'), ...wk('2026-11-09'));
    // недели: 19.10 met, 26.10 met, 02.11 miss, 09.11 met, 16.11 open
    const s = weeklyStat(ARC, '2026-11-17', weekly(2), done);
    expect(s.streak).toBe(1); // 09.11, дальше провал 02.11
    expect(s.weeksMet).toBe(3);
    expect(s.last4.map((w) => w.state)).toEqual(['met', 'miss', 'met', 'open']);
  });

  it('всего отметок считает и сверх нормы', () => {
    const done = set('2026-10-19', '2026-10-20', '2026-10-21');
    expect(weeklyStat(ARC, '2026-10-26', weekly(2), done).done).toBe(3);
  });

  it('прогресс на дату берёт неделю этой даты', () => {
    const done = set('2026-10-19', '2026-10-27');
    expect(habitProgress(ARC, '2026-10-28', weekly(2), done, set(), '2026-10-28')).toEqual({ kind: 'week', done: 1, target: 2 });
    expect(habitProgress(ARC, '2026-10-28', weekly(2), done, set(), '2026-10-21')).toEqual({ kind: 'week', done: 1, target: 2 });
  });

  it('у ежедневного прогресса нет', () => {
    expect(habitProgress(ARC, '2026-10-28', { type: 'daily', target: null, createdAt: null }, set(), set(), '2026-10-28')).toBeNull();
  });
});

describe('цель на всю арку', () => {
  it('считает отметки внутри арки, сверх цели копится', () => {
    const done = set('2026-10-19', '2026-10-20', '2026-10-21');
    expect(arcStat(ARC, '2026-10-21', 2, done)).toMatchObject({ done: 3, target: 2, ratio: 1.5 });
  });

  it('по графику: к концу арки нужна вся цель, к середине около половины', () => {
    const none = set();
    expect(arcStat(ARC, '2026-10-19', 20, none).onTrack).toBe(true); // 1 из 133 дней: ждать ещё нечего
    expect(arcStat(ARC, '2026-12-25', 20, none).onTrack).toBe(false); // середина арки без отметок
    const ten = set(...Array.from({ length: 10 }, (_, i) => addDays('2026-10-19', i * 3)));
    expect(arcStat(ARC, '2026-12-25', 20, ten).onTrack).toBe(true);
    expect(arcStat(ARC, '2027-02-28', 20, ten).onTrack).toBe(false);
  });

  it('прогресс — общий счётчик за арку', () => {
    const spec: HabitSpec = { type: 'arc_total', target: 20, createdAt: '2026-10-19' };
    expect(habitProgress(ARC, '2026-11-01', spec, set('2026-10-20', '2026-10-25'), set(), '2026-11-01')).toEqual({ kind: 'arc', done: 2, target: 20 });
  });

  it('отметки вне арки не считаются', () => {
    expect(arcStat(ARC, '2026-11-01', 5, set('2026-10-01', '2026-10-20')).done).toBe(1);
  });
});
