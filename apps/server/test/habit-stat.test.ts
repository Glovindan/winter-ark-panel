import { describe, expect, it } from 'vitest';
import { addDays, habitStat } from '@ark/shared';

const TODAY = '2026-11-10';
const ID = 7;

/** Дни от сегодняшнего назад; doneAgo — на сколько дней назад пункт выполнен (0 = сегодня). */
function days(doneAgo: number[], count = 10) {
  return Array.from({ length: count }, (_, i) => ({ date: addDays(TODAY, -i), done: doneAgo.includes(i) ? [ID] : [] }));
}

describe('habitStat', () => {
  it('считает выполненные дни и серию, сегодняшний день ещё открыт', () => {
    const s = habitStat(days([1, 2, 3]), ID, new Set(), TODAY); // сегодня пока без отметки
    expect(s.done).toBe(3);
    expect(s.streak).toBe(3);
  });

  it('сегодняшняя отметка продлевает серию', () => {
    expect(habitStat(days([0, 1, 2]), ID, new Set(), TODAY).streak).toBe(3);
  });

  it('пропущенный вчера день обрывает серию', () => {
    expect(habitStat(days([0, 2, 3]), ID, new Set(), TODAY).streak).toBe(1);
  });

  it('дни паузы серию не рвут и не продлевают', () => {
    const paused = new Set([addDays(TODAY, -2), addDays(TODAY, -3)]);
    expect(habitStat(days([0, 1, 4, 5]), ID, paused, TODAY).streak).toBe(4);
  });

  it('полоска последних 7 дней: от старых к свежим', () => {
    const paused = new Set([addDays(TODAY, -4)]);
    const s = habitStat(days([1, 2, 6]), ID, paused, TODAY);
    // слева 6 дней назад (done), справа сегодня (open)
    expect(s.last7).toEqual(['done', 'miss', 'pause', 'miss', 'done', 'done', 'open']);
  });

  it('дни до первой отметки не считаются пропусками: пункта могло ещё не быть', () => {
    const s = habitStat(days([1]), ID, new Set(), TODAY); // выполнен один раз, вчера
    expect(s.last7).toEqual(['none', 'none', 'none', 'none', 'none', 'done', 'open']);
  });

  it('пункт без единой отметки: ни пропусков, ни серии', () => {
    const s = habitStat(days([]), ID, new Set(), TODAY);
    expect(s).toMatchObject({ done: 0, streak: 0 });
    expect(s.last7.every((m) => m === 'none' || m === 'open')).toBe(true);
  });

  it('чужие пункты не учитываются', () => {
    const d = [{ date: TODAY, done: [99] }];
    expect(habitStat(d, ID, new Set(), TODAY)).toMatchObject({ done: 0, streak: 0 });
  });

  it('короткая история (меньше 7 дней) не ломает расчёт', () => {
    const s = habitStat(days([0, 1], 2), ID, new Set(), TODAY);
    expect(s.last7).toEqual(['done', 'done']);
    expect(s.streak).toBe(2);
  });
});
