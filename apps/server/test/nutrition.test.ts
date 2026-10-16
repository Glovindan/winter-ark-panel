import { describe, expect, it } from 'vitest';
import { activityFromWorkouts, calcNutrition, isValidBody, type BodyInput } from '@ark/shared';

const man: BodyInput = { sex: 'male', age: 30, heightCm: 180, weightKg: 80, activity: 'moderate', goal: 'maintain' };
const woman: BodyInput = { sex: 'female', age: 25, heightCm: 165, weightKg: 60, activity: 'light', goal: 'maintain' };

describe('calcNutrition', () => {
  it('формула Миффлина — Сан-Жеора для мужчины', () => {
    const p = calcNutrition(man)!;
    expect(p.bmr).toBe(1780); // 800 + 1125 − 150 + 5
    expect(p.tdee).toBe(2759); // × 1,55
    expect(p.kcal).toBe(2760); // округление до 10
    expect(p.warnings).toEqual([]);
  });

  it('и для женщины', () => {
    const p = calcNutrition(woman)!;
    expect(p.bmr).toBe(1345); // 600 + 1031,25 − 125 − 161
    expect(p.kcal).toBe(1850); // 1849,7 → 1850
  });

  it('цель меняет калории: −15% и +10%', () => {
    expect(calcNutrition({ ...man, goal: 'cut' })!.kcal).toBe(2350);
    expect(calcNutrition({ ...man, goal: 'gain' })!.kcal).toBe(3030);
  });

  it('БЖУ: белок и жиры от веса, углеводы — остаток', () => {
    const p = calcNutrition({ ...man, goal: 'cut' })!;
    expect(p).toMatchObject({ kcal: 2350, protein: 160, fat: 72, carb: 266 });
    // сумма калорий БЖУ сходится с нормой с точностью до округления
    expect(Math.abs(p.protein * 4 + p.fat * 9 + p.carb * 4 - p.kcal)).toBeLessThanOrEqual(12);
  });

  it('не опускается ниже безопасного минимума и предупреждает', () => {
    const tiny: BodyInput = { sex: 'female', age: 40, heightCm: 150, weightKg: 45, activity: 'sedentary', goal: 'cut' };
    const p = calcNutrition(tiny)!;
    expect(p.kcal).toBe(1200);
    expect(p.warnings).toHaveLength(1);
    expect(calcNutrition({ ...tiny, sex: 'male' })!.kcal).toBeGreaterThanOrEqual(1500);
  });

  it('белок и жиры не превышают 35% калорий, углеводы не уходят в минус', () => {
    const heavy: BodyInput = { sex: 'male', age: 35, heightCm: 175, weightKg: 150, activity: 'sedentary', goal: 'cut' };
    const p = calcNutrition(heavy)!;
    expect(p.protein * 4).toBeLessThanOrEqual(p.kcal * 0.35 + 4);
    expect(p.fat * 9).toBeLessThanOrEqual(p.kcal * 0.35 + 9);
    expect(p.carb).toBeGreaterThan(0);
  });

  it.each([
    [{ age: 13 }], [{ age: 91 }], [{ heightCm: 119 }], [{ heightCm: 231 }], [{ weightKg: 29 }], [{ weightKg: 251 }], [{ age: NaN }],
  ])('отклоняет данные вне диапазонов %j', (override) => {
    expect(calcNutrition({ ...man, ...override })).toBeNull();
    expect(isValidBody({ ...man, ...override })).toBe(false);
  });

  it('активность по умолчанию берётся из числа тренировок', () => {
    expect(activityFromWorkouts(1)).toBe('light');
    expect(activityFromWorkouts(3)).toBe('moderate');
    expect(activityFromWorkouts(6)).toBe('high');
  });

  it('больше активность — больше калорий, женщина получает меньше мужчины при прочих равных', () => {
    const levels = (['sedentary', 'light', 'moderate', 'high'] as const).map((activity) => calcNutrition({ ...man, activity })!.kcal);
    expect([...levels].sort((a, b) => a - b)).toEqual(levels);
    expect(calcNutrition({ ...man, sex: 'female' })!.kcal).toBeLessThan(calcNutrition(man)!.kcal);
  });
});
