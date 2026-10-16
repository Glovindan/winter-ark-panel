import type {
  AchievementView,
  AuthResponse,
  DashboardResponse,
  HabitType,
  ProfileUpdate,
  TodayHabit,
  TodayResponse,
  UserDetailResponse,
  UserProfile,
} from '@ark/shared';

declare global {
  interface Window {
    Telegram?: { WebApp?: { initData: string; ready(): void; expand(): void } };
  }
}

const BASE = '/api';
let token: string | null = null;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`${method} ${path}: ${res.status} ${detail}`.trim());
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export async function login(): Promise<AuthResponse> {
  const tg = window.Telegram?.WebApp;
  tg?.ready();
  tg?.expand();
  const body = tg?.initData
    ? { initData: tg.initData }
    : import.meta.env.DEV
      ? { dev: { id: 1, name: 'Dev User' } } // вне Telegram, только в dev-сборке (нужен DEV_AUTH=1 на сервере)
      : {};
  const auth = await request<AuthResponse>('POST', '/auth', body);
  token = auth.token;
  return auth;
}

export const getDashboard = () => request<DashboardResponse>('GET', '/dashboard');

export const getUserDays = (id: number) => request<UserDetailResponse>('GET', `/users/${id}/days`);

export const getToday =(date?: string) =>
  request<TodayResponse>('GET', date ? `/today?date=${date}` : '/today');

export const setCheckin = (habitId: number, date: string, done: boolean) =>
  request<TodayResponse>('PUT', '/checkin', { habitId, date, done });

export const addPause = (days: number) => request<TodayResponse>('POST', '/pause', { days });

export const cancelPause = () => request<TodayResponse>('DELETE', '/pause');

export const getAchievements = () => request<AchievementView[]>('GET', '/achievements');

export const addHabit = (habit: { title: string; type: HabitType; target?: number }) =>
  request<TodayHabit>('POST', '/habits', habit);

export const deleteHabit = (id: number) => request<void>('DELETE', `/habits/${id}`);

export const saveProfile = (update: ProfileUpdate) => request<UserProfile>('PUT', '/me', update);
