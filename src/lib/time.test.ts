import { describe, expect, it } from 'vitest';
import { addDays, dateKey, dayRange, isRealCalendarDate, resolveDateParam, resolveZone } from './time';

describe('dayRange', () => {
  it('Asia/Phnom_Penh (UTC+7, no DST): midnight is 17:00 UTC the day before', () => {
    const { start, end } = dayRange('2026-10-07', 'Asia/Phnom_Penh');
    expect(start.toISOString()).toBe('2026-10-06T17:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-07T17:00:00.000Z');
  });

  it('America/Los_Angeles (PDT, UTC-7): midnight is 07:00 UTC', () => {
    const { start, end } = dayRange('2026-10-06', 'America/Los_Angeles');
    expect(start.toISOString()).toBe('2026-10-06T07:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-07T07:00:00.000Z');
  });

  it('a DST change day is 25 hours long in Los Angeles (2026-11-01) and 23 in March', () => {
    const fall = dayRange('2026-11-01', 'America/Los_Angeles');
    expect((fall.end.getTime() - fall.start.getTime()) / 3600_000).toBe(25);
    const spring = dayRange('2026-03-08', 'America/Los_Angeles');
    expect((spring.end.getTime() - spring.start.getTime()) / 3600_000).toBe(23);
  });
});

describe('dateKey', () => {
  it('assigns the same instant to different days in different zones', () => {
    const t = new Date('2026-10-06T18:30:00Z');
    expect(dateKey(t, 'Asia/Phnom_Penh')).toBe('2026-10-07');
    expect(dateKey(t, 'America/Los_Angeles')).toBe('2026-10-06');
    expect(dateKey(t, 'UTC')).toBe('2026-10-06');
  });

  it('local midnight belongs to the new day, one millisecond earlier to the old one', () => {
    expect(dateKey(new Date('2026-10-06T17:00:00.000Z'), 'Asia/Phnom_Penh')).toBe('2026-10-07');
    expect(dateKey(new Date('2026-10-06T16:59:59.999Z'), 'Asia/Phnom_Penh')).toBe('2026-10-06');
    expect(dateKey(new Date('2026-10-07T06:59:59.999Z'), 'America/Los_Angeles')).toBe('2026-10-06');
    expect(dateKey(new Date('2026-10-07T07:00:00.000Z'), 'America/Los_Angeles')).toBe('2026-10-07');
  });
});

describe('resolveDateParam', () => {
  const now = new Date('2026-10-06T18:30:00Z'); // Oct 7 01:30 in Phnom Penh, Oct 6 11:30 in LA
  it('maps today and yesterday in the given zone', () => {
    expect(resolveDateParam('today', 'Asia/Phnom_Penh', now)).toBe('2026-10-07');
    expect(resolveDateParam('yesterday', 'Asia/Phnom_Penh', now)).toBe('2026-10-06');
    expect(resolveDateParam(undefined, 'America/Los_Angeles', now)).toBe('2026-10-06');
    expect(resolveDateParam('yesterday', 'America/Los_Angeles', now)).toBe('2026-10-05');
  });
  it('passes real dates through and rejects the rest', () => {
    expect(resolveDateParam('2026-02-28', 'UTC', now)).toBe('2026-02-28');
    expect(() => resolveDateParam('2026-02-30', 'UTC', now)).toThrow();
    expect(() => resolveDateParam('tomorrow', 'UTC', now)).toThrow();
  });
});

describe('misc', () => {
  it('resolveZone prefers a valid header, then the user zone, then UTC', () => {
    expect(resolveZone('America/New_York', 'Asia/Phnom_Penh')).toBe('America/New_York');
    expect(resolveZone('nonsense', 'Asia/Phnom_Penh')).toBe('Asia/Phnom_Penh');
    expect(resolveZone(undefined, null)).toBe('UTC');
  });
  it('isRealCalendarDate', () => {
    expect(isRealCalendarDate('2024-02-29')).toBe(true);
    expect(isRealCalendarDate('2025-02-29')).toBe(false);
    expect(isRealCalendarDate('2025-13-01')).toBe(false);
    expect(isRealCalendarDate('20250101')).toBe(false);
  });
  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
