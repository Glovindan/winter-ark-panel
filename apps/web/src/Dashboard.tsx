import { useEffect, useMemo, useState } from 'react';
import { achievementByCode, overall, type DashboardResponse, type DashboardUser } from '@ark/shared';
import { getDashboard } from './api';
import { Avatar } from './Avatar';
import { Ring } from './Ring';

const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

export function Dashboard({ meId, onOpen }: { meId: number; onOpen: (id: number) => void }) {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDashboard().then(setData, (e) => setError(String(e.message ?? e)));
  }, []);

  const sorted = useMemo(() => {
    if (!data) return [];
    const score = (u: DashboardUser) => {
      const o = overall(u.rings);
      return o.total ? o.done / o.total : 0;
    };
    return [...data.users].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name, 'ru'));
  }, [data]);

  if (error) return <p className="note">Не удалось загрузить: {error}</p>;
  if (!data) return <p className="note">Загрузка…</p>;

  return (
    <div>
      <header className="head">
        <div>
          <h1>Участники</h1>
          <p className="sub">Кольца снаружи внутрь: питание, тренировки, сон</p>
        </div>
      </header>
      <div className="legend">
        <span><i className="dot done" />выполнено</span>
        <span><i className="dot skipped" />пропущено</span>
        <span><i className="dot rest" />впереди</span>
      </div>
      <div className="grid">
        {sorted.map((u) => {
          const o = overall(u.rings);
          return (
            <button key={u.id} className="card" onClick={() => onOpen(u.id)}>
              <Ring rings={u.rings} size={112}>
                <Avatar name={u.name} url={u.avatarUrl} size={46} />
              </Ring>
              <p className="ttl">{u.name}{u.id === meId ? ' (вы)' : ''}</p>
              <p className="sub">
                <span className="ok">{pct(o.done, o.total)}%</span> · <span className="bad">{pct(o.skipped, o.total)}%</span>
                {u.streak > 0 && <span> · 🔥{u.streak}</span>}
              </p>
              {u.badges.length > 0 && (
                <p className="badges">
                  {u.badges.map((code) => {
                    const a = achievementByCode(code);
                    return a ? <span key={code} title={a.title}>{a.icon}</span> : null;
                  })}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
