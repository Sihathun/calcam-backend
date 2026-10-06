import { DateTime } from 'luxon';
import { badRequest } from './errors';

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Zone for a request: a valid X-Timezone header wins, then the stored user timezone, then UTC. */
export function resolveZone(header: string | undefined, userTimezone: string | null | undefined): string {
  if (header && isValidTimeZone(header)) return header;
  if (userTimezone && isValidTimeZone(userTimezone)) return userTimezone;
  return 'UTC';
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isRealCalendarDate(s: string): boolean {
  return DATE_RE.test(s) && DateTime.fromISO(s, { zone: 'utc' }).isValid;
}

/** The calendar day (YYYY-MM-DD) that `instant` falls on in `zone`. */
export function dateKey(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toFormat('yyyy-LL-dd');
}

/** Resolves "today", "yesterday" or YYYY-MM-DD relative to `now` in `zone`. */
export function resolveDateParam(param: string | undefined, zone: string, now: Date): string {
  if (!param || param === 'today') return dateKey(now, zone);
  if (param === 'yesterday') {
    return DateTime.fromJSDate(now, { zone }).minus({ days: 1 }).toFormat('yyyy-LL-dd');
  }
  if (!isRealCalendarDate(param)) throw badRequest('VALIDATION_ERROR', 'date must be YYYY-MM-DD, today or yesterday');
  return param;
}

/** [start, end) of a calendar day in `zone`, as UTC instants. DST-safe because the end is the next local midnight. */
export function dayRange(date: string, zone: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(date, { zone }).startOf('day');
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).startOf('day').toJSDate() };
}

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: 'utc' }).plus({ days }).toFormat('yyyy-LL-dd');
}
