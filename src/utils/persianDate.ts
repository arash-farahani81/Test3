/**
 * Shared Persian Date/Time Formatter & 33-Year Khayyam Leap Cycle Utility
 * Formats epoch milliseconds into a consistent Solar Hijri (fa-IR-u-ca-persian) date and 24-hour time string.
 */

export function isPersianLeapYear(jalaliYear: number): boolean {
  if (!Number.isFinite(jalaliYear)) return false;
  const rem = ((Math.trunc(jalaliYear) % 33) + 33) % 33;
  return [1, 5, 9, 13, 17, 22, 26, 30].includes(rem);
}

export function getCurrentPersianDateTimeStr(nowMs: number = Date.now()): string {
  const d = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  try {
    const dateFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const timeFormatter = new Intl.DateTimeFormat('fa-IR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const datePart = dateFormatter.format(d);
    const timePart = timeFormatter.format(d);
    return `${datePart} - ${timePart}`;
  } catch {
    return d.toLocaleDateString('fa-IR');
  }
}
