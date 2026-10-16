/** "HH:MM" -> минуты от полуночи */
export const minutesOfDay = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Текущее время суток "HH:MM" в заданном часовом поясе. */
export function clockInTz(tz: string, now: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}
