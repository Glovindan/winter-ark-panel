import { useState } from 'react';
import type { ProfileUpdate, UserProfile } from '@ark/shared';
import { saveProfile } from './api';

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));

export function Profile({ user, onSaved }: { user: UserProfile; onSaved: (u: UserProfile) => void }) {
  const [f, setF] = useState({
    kcal: user.kcal?.toString() ?? '',
    protein: user.protein?.toString() ?? '',
    fat: user.fat?.toString() ?? '',
    carb: user.carb?.toString() ?? '',
    sleepHours: String(user.sleepHours),
    workoutsPerWeek: String(user.workoutsPerWeek),
    pollTime: user.pollTime,
  });
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF({ ...f, [k]: e.target.value });
    setState('idle');
  };

  const save = async () => {
    const update: ProfileUpdate = {
      kcal: numOrNull(f.kcal),
      protein: numOrNull(f.protein),
      fat: numOrNull(f.fat),
      carb: numOrNull(f.carb),
      sleepHours: Number(f.sleepHours.replace(',', '.')),
      workoutsPerWeek: Number(f.workoutsPerWeek),
      pollTime: f.pollTime,
    };
    setState('saving');
    try {
      onSaved(await saveProfile(update));
      setState('saved');
    } catch (e) {
      setMessage(String((e as Error).message));
      setState('error');
    }
  };

  const field = (label: string, key: keyof typeof f, props: Record<string, unknown> = {}) => (
    <label className="fld">
      <span>{label}</span>
      <input value={f[key]} onChange={set(key)} {...props} />
    </label>
  );

  return (
    <div>
      <div className="me">
        {user.avatarUrl ? (
          <img className="avatar" src={user.avatarUrl} alt="" />
        ) : (
          <div className="avatar">{initials(user.name)}</div>
        )}
        <div>
          <p className="ttl big">{user.name}</p>
          <p className="sub">Профиль из Telegram</p>
        </div>
      </div>

      <p className="sec">Питание</p>
      {field('Калории, ккал', 'kcal', { inputMode: 'numeric', placeholder: '2300' })}
      {field('Белки, г', 'protein', { inputMode: 'numeric' })}
      {field('Жиры, г', 'fat', { inputMode: 'numeric' })}
      {field('Углеводы, г', 'carb', { inputMode: 'numeric' })}

      <p className="sec">Сон и тренировки</p>
      {field('Норма сна, ч', 'sleepHours', { inputMode: 'decimal' })}
      <label className="fld">
        <span>Тренировок в неделю</span>
        <select value={f.workoutsPerWeek} onChange={set('workoutsPerWeek')}>
          {[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>

      <p className="sec">Опрос в боте</p>
      {field('Время вечернего опроса', 'pollTime', { type: 'time' })}

      <div className="pad">
        <button className="wide" onClick={save} disabled={state === 'saving'}>
          {state === 'saving' ? 'Сохраняю…' : 'Сохранить'}
        </button>
        {state === 'saved' && <p className="note ok">Сохранено</p>}
        {state === 'error' && <p className="note err">Не сохранилось: проверь значения. {message}</p>}
      </div>
    </div>
  );
}
