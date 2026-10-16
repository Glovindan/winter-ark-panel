import { useEffect, useMemo, useState } from 'react';
import {
  ACTIVITY_LEVELS,
  activityFromWorkouts,
  BODY_LIMITS,
  calcNutrition,
  GOALS,
  type ActivityLevel,
  type Goal,
  type NutritionPlan,
  type Sex,
} from '@ark/shared';

const STORAGE_KEY = 'ark.calc';

interface Form {
  sex: Sex;
  age: string;
  heightCm: string;
  weightKg: string;
  activity: ActivityLevel;
  goal: Goal;
}

/** Данные тела хранятся только на этом устройстве и никуда не отправляются. */
function load(defaultActivity: ActivityLevel): Form {
  const base: Form = { sex: 'male', age: '', heightCm: '', weightKg: '', activity: defaultActivity, goal: 'maintain' };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Form> | null;
    return saved ? { ...base, ...saved } : base;
  } catch {
    return base;
  }
}

const num = (s: string) => Number(s.replace(',', '.'));

export function CalorieCalc({
  workoutsPerWeek,
  onApply,
}: {
  workoutsPerWeek: number;
  onApply: (plan: NutritionPlan) => void;
}) {
  const [f, setF] = useState<Form>(() => load(activityFromWorkouts(workoutsPerWeek)));
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(f));
    } catch {
      /* хранилище недоступно, расчёт всё равно работает */
    }
  }, [f]);

  const plan = useMemo(
    () => calcNutrition({ sex: f.sex, age: num(f.age), heightCm: num(f.heightCm), weightKg: num(f.weightKg), activity: f.activity, goal: f.goal }),
    [f],
  );
  const filled = f.age !== '' && f.heightCm !== '' && f.weightKg !== '';

  const set = <K extends keyof Form>(k: K) => (e: { target: { value: string } }) => {
    setF({ ...f, [k]: e.target.value as Form[K] });
    setApplied(false);
  };

  return (
    <details className="calc">
      <summary>🧮 Рассчитать норму калорий</summary>

      <label className="fld">
        <span>Пол</span>
        <select value={f.sex} onChange={set('sex')}>
          <option value="male">Мужской</option>
          <option value="female">Женский</option>
        </select>
      </label>
      <label className="fld">
        <span>Возраст, лет</span>
        <input value={f.age} onChange={set('age')} inputMode="numeric" placeholder={`${BODY_LIMITS.age.min}–${BODY_LIMITS.age.max}`} />
      </label>
      <label className="fld">
        <span>Рост, см</span>
        <input value={f.heightCm} onChange={set('heightCm')} inputMode="decimal" placeholder={`${BODY_LIMITS.heightCm.min}–${BODY_LIMITS.heightCm.max}`} />
      </label>
      <label className="fld">
        <span>Вес, кг</span>
        <input value={f.weightKg} onChange={set('weightKg')} inputMode="decimal" placeholder={`${BODY_LIMITS.weightKg.min}–${BODY_LIMITS.weightKg.max}`} />
      </label>
      <label className="fld col">
        <span>Активность</span>
        <select value={f.activity} onChange={set('activity')}>
          {ACTIVITY_LEVELS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
      </label>
      <label className="fld col">
        <span>Цель</span>
        <select value={f.goal} onChange={set('goal')}>
          {GOALS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
        </select>
      </label>

      <div className="calc-result">
        {plan ? (
          <>
            <p className="ttl">{plan.kcal} ккал в день</p>
            <p className="sub">Белки {plan.protein} г · жиры {plan.fat} г · углеводы {plan.carb} г</p>
            <p className="sub">Базовый обмен {plan.bmr} ккал, с учётом активности {plan.tdee} ккал</p>
            {plan.warnings.map((w) => <p key={w} className="note err">{w}</p>)}
            <button className="wide" onClick={() => { onApply(plan); setApplied(true); }}>Подставить в поля выше</button>
            {applied && <p className="note ok">Подставлено. Нажми «Сохранить» внизу страницы.</p>}
          </>
        ) : (
          <p className="note">
            {filled ? 'Проверь значения: возраст, рост и вес выходят за допустимые пределы.' : 'Введи возраст, рост и вес, и я посчитаю.'}
          </p>
        )}
        <p className="note">
          Это ориентир по формуле Миффлина — Сан-Жеора, а не медицинская рекомендация. Вес, рост и возраст хранятся только на
          этом устройстве. При заболеваниях и беременности проконсультируйся с врачом.
        </p>
      </div>
    </details>
  );
}
