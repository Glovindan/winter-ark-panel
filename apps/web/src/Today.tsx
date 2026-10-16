import { useCallback, useEffect, useState } from 'react';
import { MAX_CUSTOM_HABITS, MAX_HABIT_TITLE, type TodayHabit, type TodayResponse } from '@ark/shared';
import { addHabit, deleteHabit, getToday, setCheckin } from './api';

const fmtDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

function subtitle(h: TodayHabit, data: TodayResponse): string | null {
  if (h.kind === 'nutrition') {
    return data.norms.kcal ? `Уложился в КБЖУ · ${data.norms.kcal} ккал` : 'Уложился в КБЖУ';
  }
  if (h.kind === 'sleep') return `Не меньше ${String(data.norms.sleepHours).replace('.', ',')} ч`;
  return null;
}

export function Today({ onNeedProfile }: { onNeedProfile?: () => void }) {
  const [date, setDate] = useState<string | undefined>(undefined);
  const [data, setData] = useState<TodayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');

  const load = useCallback((d?: string) => {
    getToday(d).then(
      (r) => { setData(r); setError(null); },
      (e) => setError(String(e.message ?? e)),
    );
  }, []);

  useEffect(() => load(date), [date, load]);

  if (error && !data) return <p className="note">Не удалось загрузить: {error}</p>;
  if (!data) return <p className="note">Загрузка…</p>;

  const isToday = data.date === data.today;
  const fixed = data.habits.filter((h) => h.kind !== 'custom');
  const custom = data.habits.filter((h) => h.kind === 'custom');

  const toggle = async (h: TodayHabit) => {
    if (!data.editable) return;
    const prev = data;
    setData({ ...data, habits: data.habits.map((x) => (x.id === h.id ? { ...x, done: !x.done } : x)) });
    try {
      setData(await setCheckin(h.id, data.date, !h.done));
      setError(null);
    } catch (e) {
      setData(prev);
      setError(String((e as Error).message));
    }
  };

  const submitHabit = async () => {
    const t = title.trim();
    if (!t) return;
    try {
      await addHabit(t);
      setTitle('');
      setAdding(false);
      load(date);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const remove = async (h: TodayHabit) => {
    if (!window.confirm(`Удалить «${h.title}»? Отметки по нему тоже пропадут.`)) return;
    try {
      await deleteHabit(h.id);
      load(date);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const row = (h: TodayHabit, removable: boolean) => (
    <div
      key={h.id}
      className={`row${h.done ? ' on' : ''}${data.editable ? '' : ' locked'}`}
      onClick={() => toggle(h)}
      role="checkbox"
      aria-checked={h.done}
    >
      <span className="ck" aria-hidden="true">✓</span>
      <div className="grow">
        <p className="ttl">{h.title}</p>
        {subtitle(h, data) && <p className="sub">{subtitle(h, data)}</p>}
        {h.kind === 'workout' && (
          <>
            <p className="sub">Неделя: {Math.min(data.workout.done, data.workout.target)} из {data.workout.target}</p>
            <div className="dots">
              {Array.from({ length: data.workout.target }, (_, i) => (
                <span key={i} className={i < data.workout.done ? 'f' : ''} />
              ))}
            </div>
          </>
        )}
      </div>
      {removable && (
        <button
          className="icon"
          aria-label={`Удалить ${h.title}`}
          onClick={(e) => { e.stopPropagation(); remove(h); }}
        >×</button>
      )}
    </div>
  );

  return (
    <div>
      <header className="head">
        <div>
          <p className="sub">
            {data.dayNumber ? `День ${data.dayNumber} из ${data.totalDays}` : `Всего дней: ${data.totalDays}`}
          </p>
          <h1>{isToday ? 'Сегодня' : 'Вчера'}, {fmtDate(data.date)}</h1>
        </div>
        <div className="seg">
          <button className={!isToday ? 'sel' : ''} onClick={() => setDate(data.yesterday)}>Вчера</button>
          <button className={isToday ? 'sel' : ''} onClick={() => setDate(undefined)}>Сегодня</button>
        </div>
      </header>

      {data.state === 'before' && (
        <p className="banner">Арка стартует {fmtDate(data.startDate)}. Пока отметки недоступны.</p>
      )}
      {data.state === 'after' && <p className="banner">Арка закончилась.</p>}
      {data.state === 'active' && !data.editable && (
        <p className="banner">Эту дату уже нельзя править.</p>
      )}
      {error && <p className="banner err">{error}</p>}

      <p className="sec">Обязательные</p>
      {fixed.map((h) => row(h, false))}

      <p className="sec">Мои пункты</p>
      {custom.length === 0 && <p className="note">Пока пусто. Добавь то, что хочешь отслеживать сам.</p>}
      {custom.map((h) => row(h, true))}

      <div className="pad">
        {adding ? (
          <div className="add">
            <input
              autoFocus
              value={title}
              maxLength={MAX_HABIT_TITLE}
              placeholder="10 000 шагов"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitHabit()}
            />
            <button onClick={submitHabit}>Добавить</button>
            <button className="ghost" onClick={() => { setAdding(false); setTitle(''); }}>Отмена</button>
          </div>
        ) : (
          <button
            className="wide"
            disabled={custom.length >= MAX_CUSTOM_HABITS}
            onClick={() => setAdding(true)}
          >
            + Добавить пункт
          </button>
        )}
        {custom.length >= MAX_CUSTOM_HABITS && <p className="note">Максимум {MAX_CUSTOM_HABITS} личных пунктов.</p>}
        {onNeedProfile && data.norms.kcal === null && (
          <p className="note">
            Укажи норму калорий <a href="#profile" onClick={(e) => { e.preventDefault(); onNeedProfile(); }}>в профиле</a>.
          </p>
        )}
      </div>
    </div>
  );
}
