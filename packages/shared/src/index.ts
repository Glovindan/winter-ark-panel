export * from './dates';
export * from './rings';

export type HabitKind = 'nutrition' | 'workout' | 'sleep' | 'custom';
export type CheckinStatus = 'done' | 'skipped';

export interface UserProfile {
  id: number;
  tgId: number;
  name: string;
  avatarUrl: string | null;
  kcal: number | null;
  protein: number | null;
  fat: number | null;
  carb: number | null;
  sleepHours: number;
  workoutsPerWeek: number;
  pollTime: string; // HH:MM
  isAdmin: boolean;
}

/** Поля профиля, которые пользователь может менять сам. */
export type ProfileUpdate = Partial<
  Pick<UserProfile, 'kcal' | 'protein' | 'fat' | 'carb' | 'sleepHours' | 'workoutsPerWeek' | 'pollTime'>
>;

export interface Habit {
  id: number;
  kind: HabitKind;
  ownerId: number | null;
  title: string;
}

export interface AuthResponse {
  token: string;
  user: UserProfile;
}

export interface TodayHabit {
  id: number;
  kind: HabitKind;
  title: string;
  done: boolean;
}

export interface TodayResponse {
  date: string;
  today: string;
  yesterday: string;
  /** before — арка ещё не началась, after — уже закончилась */
  state: 'before' | 'active' | 'after';
  /** Номер дня арки для запрошенной даты, null вне арки */
  dayNumber: number | null;
  totalDays: number;
  startDate: string;
  editable: boolean;
  habits: TodayHabit[];
  /** Тренировки за неделю (пн–вс), в которую попадает date */
  workout: { done: number; target: number };
  norms: { kcal: number | null; sleepHours: number };
}

export const MAX_CUSTOM_HABITS = 10;
export const MAX_HABIT_TITLE = 60;
