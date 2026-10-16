import { useEffect, useState } from 'react';
import type { AchievementView } from '@ark/shared';
import { getAchievements } from './api';

const fmt = (iso: string) =>
  new Date(iso.replace(' ', 'T') + 'Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

export function Achievements() {
  const [list, setList] = useState<AchievementView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAchievements().then(setList, (e) => setError(String(e.message ?? e)));
  }, []);

  if (error) return <p className="note">Не удалось загрузить: {error}</p>;
  if (!list) return <p className="note">Загрузка…</p>;

  const opened = list.filter((a) => a.unlockedAt).length;
  const sorted = [...list].sort((a, b) => Number(!!b.unlockedAt) - Number(!!a.unlockedAt));

  return (
    <div>
      <header className="head">
        <div>
          <h1>Награды</h1>
          <p className="sub">Открыто {opened} из {list.length}</p>
        </div>
      </header>
      <div className="ach-grid">
        {sorted.map((a) => (
          <div key={a.code} className={`ach${a.unlockedAt ? ' got' : ''}`}>
            <span className="ach-icon" aria-hidden="true">{a.icon}</span>
            <p className="ttl">{a.title}</p>
            <p className="sub">{a.description}</p>
            {a.unlockedAt && <p className="sub ok">Открыто {fmt(a.unlockedAt)}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
