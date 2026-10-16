import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { UserProfile } from '@ark/shared';
import { login } from './api';
import { Dashboard } from './Dashboard';
import { UserDetail } from './UserDetail';
import { Profile } from './Profile';
import { Today } from './Today';
import './styles.css';

type Tab = 'today' | 'users' | 'profile';

function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('today');
  const [viewUser, setViewUser] = useState<number | null>(null);

  useEffect(() => {
    login().then((a) => setUser(a.user), (e) => setError(String(e.message ?? e)));
  }, []);

  if (error?.includes('not_invited')) {
    return <p className="note">Это закрытая панель. Открой бота по ссылке-приглашению от организатора и нажми Start.</p>;
  }
  if (error) return <p className="note">Не удалось войти: {error}</p>;
  if (!user) return <p className="note">Загрузка…</p>;

  return (
    <div className="app">
      <main>
        {tab === 'today' && <Today onNeedProfile={() => setTab('profile')} />}
        {tab === 'users' && (viewUser === null
          ? <Dashboard meId={user.id} onOpen={setViewUser} />
          : <UserDetail userId={viewUser} onBack={() => setViewUser(null)} />)}
        {tab === 'profile' && <Profile user={user} onSaved={setUser} />}
      </main>
      <nav className="tabs">
        <button className={tab === 'today' ? 'a' : ''} onClick={() => setTab('today')}>Сегодня</button>
        <button className={tab === 'users' ? 'a' : ''} onClick={() => { setTab('users'); setViewUser(null); }}>Участники</button>
        <button className={tab === 'profile' ? 'a' : ''} onClick={() => setTab('profile')}>Профиль</button>
      </nav>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
