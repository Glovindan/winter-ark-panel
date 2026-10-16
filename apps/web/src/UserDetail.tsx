import { useEffect, useState } from 'react';
import { achievementByCode, habitStat, overall, RING_KINDS, weekStart, type RingKind, type UserDetailResponse } from '@ark/shared';
import { getUserDays } from './api';
import { Avatar } from './Avatar';
import { Ring } from './Ring';

const TITLES: Record<RingKind, string> = { nutrition: 'Питание', workout: 'Тренировки', sleep: 'Сон' };
const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

const dayLabel = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' });
const shortDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

export function UserDetail({ userId, onBack }: { userId: number; onBack: () => void }) {
  const [data, setData] = useState<UserDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    getUserDays(userId).then(setData, (e) => setError(String(e.message ?? e)));
  }, [userId]);

  const back = <button className="back" onClick={onBack}>← Участники</button>;
  if (error) return <div>{back}<p className="note">Не удалось загрузить: {error}</p></div>;
  if (!data) return <div>{back}<p className="note">Загрузка…</p></div>;

  const o = overall(data.rings);
  const fixed = data.habits.filter((h) => h.kind !== 'custom');
  const custom = data.habits.filter((h) => h.kind === 'custom');
  const weekByStart = new Map(data.weeks.map((w) => [w.weekStart, w]));
  const paused = new Set(data.paused);

  const mark = (done: boolean, date: string, kind: string) => {
    if (paused.has(date)) return <span className="sub">⏸</span>;
    if (done) return <span className="ok">✓</span>;
    if (date >= data.today) return <span className="sub">·</span>; // день ещё открыт
    return kind === 'workout' ? <span className="sub">·</span> : <span className="bad">✗</span>;
  };

  let lastWeek = '';
  return (
    <div>
      {back}
      <div className="me">
        <Ring rings={data.rings} size={96}>
          <Avatar name={data.user.name} url={data.user.avatarUrl} size={40} />
        </Ring>
        <div>
          <p className="ttl big">{data.user.name}</p>
          <p className="sub">
            <span className="ok">{pct(o.done, o.total)}% выполнено</span> · <span className="bad">{pct(o.skipped, o.total)}% пропущено</span>
          </p>
        </div>
      </div>

      <p className="streak">
        🔥 Серия: <b>{data.streak.current}</b> дн. · лучшая {data.streak.best} · заморозок: {data.streak.freezesLeft}
      </p>
      {data.achievements.length > 0 && (
        <div className="chips pad">
          {data.achievements.map((u) => {
            const a = achievementByCode(u.code);
            return a ? <span key={u.code} className="chip" title={a.description}>{a.icon} {a.title}</span> : null;
          })}
        </div>
      )}

      <p className="sec">Итоги по пунктам</p>
      {RING_KINDS.map((k) => {
        const r = data.rings[k];
        return (
          <div key={k} className="fld">
            <span>{TITLES[k]}</span>
            <span className="stat">
              <span className="ok">{r.done}</span> / <span className="bad">{r.skipped}</span> / {r.total}
            </span>
          </div>
        );
      })}
      <p className="note">Выполнено / пропущено / всего слотов. Тренировки считаются по неделям: цель {data.user.workoutsPerWeek} в неделю.</p>

      {custom.length > 0 && (
        <>
          <p className="sec">Личные пункты</p>
          {custom.map((h) => {
            const s = habitStat(data.days, h.id, paused, data.today);
            return (
              <div key={h.id} className="fld habit">
                <div className="grow">
                  <p className="ttl">{h.title}</p>
                  <p className="sub">Выполнено {s.done} дн.{s.streak > 0 ? ` · серия ${s.streak}` : ''}</p>
                </div>
                <span className="strip" role="img" aria-label="Последние 7 дней">
                  {s.last7.map((m, i) => <i key={i} className={`cell ${m}`} />)}
                </span>
              </div>
            );
          })}
          <p className="note">Личные пункты участник выбирает сам, в кольца и общий процент они не входят. Справа последние 7 дней.</p>
        </>
      )}

      <p className="sec">По дням</p>
      {data.days.map((day) => {
        const ws = weekStart(day.date);
        const header = ws !== lastWeek ? weekByStart.get(ws) : undefined;
        lastWeek = ws;
        const done = new Set(day.done);
        return (
          <div key={day.date}>
            {header && (
              <p className="week">
                Неделя {shortDate(header.from)} – {shortDate(header.to > data.today ? data.today : header.to)} ·
                тренировок {header.done} из {header.target}
                {header.closed && header.done < header.target && <span className="bad"> · недобор</span>}
              </p>
            )}
            <div className="day">
              <p className="ttl">{dayLabel(day.date)}{paused.has(day.date) && <span className="sub"> · ⏸ пауза</span>}</p>
              <div className="chips">
                {fixed.map((h) => (
                  <span key={h.id} className="chip">{TITLES[h.kind as RingKind].replace('Тренировки', 'Тренировка')} {mark(done.has(h.id), day.date, h.kind)}</span>
                ))}
                {custom.map((h) => (
                  <span key={h.id} className="chip alt">{h.title} {mark(done.has(h.id), day.date, 'custom')}</span>
                ))}
              </div>
            </div>
          </div>
        );
      })}
      {data.days.length === 0 && <p className="note">Арка ещё не началась.</p>}
    </div>
  );
}
