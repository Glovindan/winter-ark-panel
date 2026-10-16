export type Sex = 'male' | 'female';
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'high';
export type Goal = 'cut' | 'maintain' | 'gain';

export interface BodyInput {
  sex: Sex;
  age: number;
  heightCm: number;
  weightKg: number;
  activity: ActivityLevel;
  goal: Goal;
}

export interface NutritionPlan {
  /** базовый обмен, ккал */
  bmr: number;
  /** суточный расход с учётом активности, ккал */
  tdee: number;
  kcal: number;
  protein: number;
  fat: number;
  carb: number;
  warnings: string[];
}

export const ACTIVITY_LEVELS: { value: ActivityLevel; label: string; factor: number }[] = [
  { value: 'sedentary', label: 'Почти нет тренировок, сидячая работа', factor: 1.2 },
  { value: 'light', label: '1–2 тренировки в неделю', factor: 1.375 },
  { value: 'moderate', label: '3–4 тренировки в неделю', factor: 1.55 },
  { value: 'high', label: '5 и больше тренировок в неделю', factor: 1.725 },
];

export const GOALS: { value: Goal; label: string; factor: number }[] = [
  { value: 'cut', label: 'Снизить вес (−15%)', factor: 0.85 },
  { value: 'maintain', label: 'Держать вес', factor: 1 },
  { value: 'gain', label: 'Набрать вес (+10%)', factor: 1.1 },
];

export const BODY_LIMITS = {
  age: { min: 14, max: 90 },
  heightCm: { min: 120, max: 230 },
  weightKg: { min: 30, max: 250 },
};

const MIN_KCAL: Record<Sex, number> = { female: 1200, male: 1500 };
const PROTEIN_PER_KG: Record<Goal, number> = { cut: 2.0, maintain: 1.6, gain: 1.8 };
const FAT_PER_KG = 0.9;
const MIN_FAT_SHARE = 0.2;
const MAX_MACRO_SHARE = 0.35;

/** Активность по числу тренировок в неделю из профиля: подсказка для значения по умолчанию. */
export function activityFromWorkouts(perWeek: number): ActivityLevel {
  if (perWeek <= 2) return 'light';
  if (perWeek <= 4) return 'moderate';
  return 'high';
}

const inRange = (v: number, r: { min: number; max: number }) => Number.isFinite(v) && v >= r.min && v <= r.max;

export const isValidBody = (b: Pick<BodyInput, 'age' | 'heightCm' | 'weightKg'>): boolean =>
  inRange(b.age, BODY_LIMITS.age) && inRange(b.heightCm, BODY_LIMITS.heightCm) && inRange(b.weightKg, BODY_LIMITS.weightKg);

/**
 * Норма калорий и БЖУ: формула Миффлина — Сан-Жеора, множитель активности и корректировка под цель.
 * Нижняя граница калорий (1200 / 1500) и верхние доли белка и жиров (по 35%) не дают получить крайние значения.
 * Возвращает null, если данные вне допустимых диапазонов.
 */
export function calcNutrition(b: BodyInput): NutritionPlan | null {
  if (!isValidBody(b)) return null;
  const activity = ACTIVITY_LEVELS.find((a) => a.value === b.activity);
  const goal = GOALS.find((g) => g.value === b.goal);
  if (!activity || !goal) return null;

  const bmr = 10 * b.weightKg + 6.25 * b.heightCm - 5 * b.age + (b.sex === 'male' ? 5 : -161);
  const tdee = bmr * activity.factor;
  const warnings: string[] = [];

  let kcal = tdee * goal.factor;
  if (kcal < MIN_KCAL[b.sex]) {
    kcal = MIN_KCAL[b.sex];
    warnings.push(`Расчёт вышел ниже безопасного минимума, поставили ${kcal} ккал. При такой цели лучше посоветоваться с врачом или диетологом.`);
  }
  kcal = Math.round(kcal / 10) * 10;

  const protein = Math.min(b.weightKg * PROTEIN_PER_KG[b.goal], (kcal * MAX_MACRO_SHARE) / 4);
  const fat = Math.min(Math.max(b.weightKg * FAT_PER_KG, (kcal * MIN_FAT_SHARE) / 9), (kcal * MAX_MACRO_SHARE) / 9);
  const carb = (kcal - protein * 4 - fat * 9) / 4;

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    kcal,
    protein: Math.round(protein),
    fat: Math.round(fat),
    carb: Math.round(carb),
    warnings,
  };
}
