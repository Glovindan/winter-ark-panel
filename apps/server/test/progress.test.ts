import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENTS,
  addDays,
  computeStreak,
  dailyRing,
  evaluateAchievements,
  hasComeback,
  perfectWeekRuns,
  weekStatsList,
  workoutRing,
  workoutWeeks,
  type History,
} from '@ark/shared';

const ARC = { startDate: '2026-10-19', endDate: '2027-02-28' };

/** Хелпер: история, где в указанные дни отмечены питание и сон, а тренировки в отдельном списке. */
function history(opts: { good?: string[]; nutrition?: string[]; sleep?: string[]; workout?: string[]; paused?: string[]; perWeek?: number } = {}): History {
  return {
    perWeek: opts.perWeek ?? 3,
    nutrition: new Set([...(opts.good ?? []), ...(opts.nutrition ?? [])]),
    sleep: new Set([...(opts.good ?? []), ...(opts.sleep ?? [])]),
    workout: new Set(opts.workout ?? []),
    paused: new Set(opts.paused ?? []),
  };
}
const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => addDays(from, i));

describe('пауза в кольцах', () => {
  it('дни паузы не считаются слотами', () => {
    const paused = new Set(days('2026-10-20', 3));
    expect(dailyRing(ARC, '2026-10-25', [], paused)).toEqual({ done: 0, skipped: 3, total: 130 }); // пропущены 19, 23, 24
  });
  it('цель тренировок пропорциональна активным дням недели', () => {
    const paused = new Set(days('2026-10-19', 7)); // вся первая неделя
    const weeks = workoutWeeks(ARC, '2026-11-30', [], 3, paused);
    expect(weeks[0]).toMatchObject({ target: 0, activeDays: 0 });
    expect(workoutRing(ARC, '2026-11-30', [], 3, paused).total).toBe(18 * 3);
    const half = new Set(days('2026-10-26', 3)); // 3 из 7 дней второй недели на паузе
    expect(workoutWeeks(ARC, '2026-11-30', [], 3, half)[1]).toMatchObject({ target: 2, activeDays: 4 }); // round(3*4/7)=2
  });
  it('отметки в дни паузы не учитываются', () => {
    const w = workoutWeeks(ARC, '2026-11-30', ['2026-10-19', '2026-10-20'], 3, new Set(['2026-10-20']));
    expect(w[0]!.done).toBe(1);
  });
});

describe('серия', () => {
  it('растёт по дням в строю, сегодня открыт', () => {
    const h = history({ good: days('2026-10-19', 3) });
    expect(computeStreak(ARC, '2026-10-22', h)).toMatchObject({ current: 3, best: 3 });
    expect(computeStreak(ARC, '2026-10-22', history({ good: days('2026-10-19', 3).concat('2026-10-22') })).current).toBe(4);
  });
  it('пропуск съедает заморозку и не рвёт серию', () => {
    const h = history({ good: ['2026-10-19', '2026-10-20', '2026-10-22'] }); // 21-го пропуск
    expect(computeStreak(ARC, '2026-10-23', h)).toEqual({ current: 3, best: 3, freezesLeft: 0, freezesUsed: 1 });
  });
  it('второй пропуск без заморозки обнуляет серию', () => {
    const h = history({ good: ['2026-10-19', '2026-10-20', '2026-10-22'] }); // пропуски 21 и 23
    const s = computeStreak(ARC, '2026-10-24', h);
    expect(s).toMatchObject({ current: 0, best: 3, freezesUsed: 1 });
  });
  it('заморозка зарабатывается каждые 14 активных дней, максимум две', () => {
    const all = days('2026-10-19', 14);
    const s = computeStreak(ARC, '2026-11-02', history({ good: all })); // 14 дней выполнено
    expect(s.freezesLeft).toBe(2); // 1 стартовая + 1 за 14 дней
    expect(computeStreak(ARC, '2026-12-20', history({ good: days('2026-10-19', 62) })).freezesLeft).toBe(2); // не больше двух
  });
  it('дни паузы серию не рвут и не продлевают', () => {
    const good = ['2026-10-19', '2026-10-20', '2026-10-24', '2026-10-25'];
    const h = history({ good, paused: ['2026-10-21', '2026-10-22', '2026-10-23'] });
    expect(computeStreak(ARC, '2026-10-26', h)).toMatchObject({ current: 4, freezesUsed: 0 });
  });
});

describe('идеальные недели', () => {
  const week1 = days('2026-10-19', 7);
  it('неделя идеальна, если все дни в строю и цель по тренировкам выполнена', () => {
    const h = history({ good: week1, workout: ['2026-10-19', '2026-10-21', '2026-10-23'] });
    const w = weekStatsList(ARC, '2026-10-26', h)[0]!;
    expect(w).toMatchObject({ perfect: true, score: 1, workoutDone: 3, workoutTarget: 3 });
  });
  it('нехватка тренировки или дня делает неделю неидеальной', () => {
    expect(weekStatsList(ARC, '2026-10-26', history({ good: week1, workout: ['2026-10-19'] }))[0]!.perfect).toBe(false);
    const h = history({ good: week1.slice(1), workout: ['2026-10-19', '2026-10-21', '2026-10-23'] });
    expect(weekStatsList(ARC, '2026-10-26', h)[0]!.perfect).toBe(false);
  });
  it('текущая неделя ещё не идеальна, пустая из-за паузы не считается', () => {
    const h = history({ good: week1, workout: ['2026-10-19', '2026-10-21', '2026-10-23'] });
    expect(weekStatsList(ARC, '2026-10-22', h)[0]!.perfect).toBe(false);
    const paused = history({ paused: week1 });
    expect(weekStatsList(ARC, '2026-10-26', paused)[0]).toMatchObject({ activeDays: 0, perfect: false, score: null });
  });
  it('цепочка идеальных недель; пауза-неделя цепочку не рвёт', () => {
    const w = (ws: string) => days(ws, 7);
    const wk = (ws: string) => [ws, addDays(ws, 2), addDays(ws, 4)];
    const h = history({
      good: [...w('2026-10-19'), ...w('2026-11-02'), ...w('2026-11-09')],
      workout: [...wk('2026-10-19'), ...wk('2026-11-02'), ...wk('2026-11-09')],
      paused: w('2026-10-26'),
    });
    expect(perfectWeekRuns(weekStatsList(ARC, '2026-11-16', h))).toEqual({ count: 3, bestRun: 3 });
  });
});

describe('камбэк', () => {
  it('3+ пропущенных дня, затем 5 в строю подряд', () => {
    const h = history({ good: [...days('2026-10-19', 2), ...days('2026-10-24', 5)] }); // пропуски 21, 22, 23
    expect(hasComeback(ARC, '2026-10-30', h)).toBe(true);
  });
  it('двух пропусков или четырёх дней подряд мало', () => {
    expect(hasComeback(ARC, '2026-10-30', history({ good: [...days('2026-10-19', 2), ...days('2026-10-23', 7)] }))).toBe(false);
    expect(hasComeback(ARC, '2026-10-30', history({ good: [...days('2026-10-19', 2), ...days('2026-10-24', 4)] }))).toBe(false);
  });
  it('пауза внутри пропусков не засчитывается как пропуск', () => {
    const h = history({ good: [...days('2026-10-19', 2), ...days('2026-10-24', 5)], paused: ['2026-10-21', '2026-10-22'] }); // пропуск реально 1 день
    expect(hasComeback(ARC, '2026-10-30', h)).toBe(false);
  });
});

describe('ачивки', () => {
  const codes = (h: History, today: string) => [...evaluateAchievements(ARC, today, h)].sort();

  it('в каталоге уникальные коды', () => {
    expect(new Set(ACHIEVEMENTS.map((a) => a.code)).size).toBe(ACHIEVEMENTS.length);
    expect(ACHIEVEMENTS.length).toBe(18);
  });
  it('пустой участник ничего не получает', () => {
    expect(codes(history(), '2026-10-25')).toEqual([]);
  });
  it('серии открываются по лучшей серии', () => {
    expect(codes(history({ good: days('2026-10-19', 7) }), '2026-10-26')).toEqual(expect.arrayContaining(['streak-3', 'streak-7']));
    expect(codes(history({ good: days('2026-10-19', 7) }), '2026-10-26')).not.toContain('streak-14');
  });
  it('ачивка по серии не пропадает, если серия потом оборвалась', () => {
    const h = history({ good: days('2026-10-19', 7) });
    expect(codes(h, '2026-12-01')).toContain('streak-7');
  });
  it('тренировки, питание, сон считают отмеченные дни', () => {
    const h = history({ nutrition: days('2026-10-19', 50), sleep: days('2026-10-19', 50), workout: days('2026-10-19', 10) });
    expect(codes(h, '2027-01-01')).toEqual(expect.arrayContaining(['workouts-10', 'nutrition-50', 'sleep-50']));
    expect(codes(h, '2027-01-01')).not.toContain('workouts-50');
  });
  it('идеальная неделя и новый год', () => {
    const h = history({ good: ['2026-12-31'] });
    expect(codes(h, '2027-01-02')).toContain('newyear');
    const perfect = history({ good: days('2026-10-19', 7), workout: ['2026-10-19', '2026-10-21', '2026-10-23'] });
    expect(codes(perfect, '2026-10-26')).toContain('perfect-week');
  });
  it('экватор: половина арки прошла и держится не меньше 60%', () => {
    const strong = history({ good: days('2026-10-19', 70), workout: [] });
    expect(codes(strong, '2026-12-28')).toContain('halfway'); // 70 дней прошло, 67+ слотов в норме
    expect(codes(history(), '2026-12-28')).not.toContain('halfway');
    expect(codes(strong, '2026-11-20')).not.toContain('halfway'); // ещё не половина
  });
  it('финишёр открывается только после конца арки при 80%', () => {
    const everyday = days('2026-10-19', 133);
    const h = history({ good: everyday, workout: days('2026-10-19', 133).filter((_, i) => i % 7 < 3) });
    expect(codes(h, '2027-02-28')).not.toContain('finisher');
    expect(codes(h, '2027-03-01')).toContain('finisher');
  });
  it('«всё и сразу»: 7 дней, когда выполнено всё', () => {
    const d = days('2026-10-19', 7);
    expect(codes(history({ good: d, workout: d }), '2026-10-26')).toContain('all-in-7');
    expect(codes(history({ good: d, workout: d.slice(1) }), '2026-10-26')).not.toContain('all-in-7');
  });
});
