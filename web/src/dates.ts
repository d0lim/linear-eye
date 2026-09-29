type DateFormat = 'calendar' | 'date' | 'dateTime' | 'time';
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string, mode: DateFormat): Intl.DateTimeFormat {
  const key = `${timezone}:${mode}`;
  const cached = dateFormatters.get(key);
  if (cached) return cached;
  const options: Intl.DateTimeFormatOptions = mode === 'calendar'
    ? { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }
    : mode === 'date'
      ? { timeZone: timezone, year: 'numeric', month: 'short', day: 'numeric' }
      : mode === 'dateTime'
        ? { timeZone: timezone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
        : { timeZone: timezone, hour: 'numeric', minute: '2-digit' };
  const created = new Intl.DateTimeFormat('en-US', options);
  if (dateFormatters.size >= 12) dateFormatters.delete(dateFormatters.keys().next().value!);
  dateFormatters.set(key, created);
  return created;
}

export function dateInZone(date: Date, timezone: string): string {
  const parts = formatter(timezone, 'calendar').formatToParts(date);
  const part = (key: string) => parts.find((value) => value.type === key)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function defaultDateRange(now: Date, timezone: string): { from: string; to: string } {
  const to = dateInZone(now, timezone);
  const start = new Date(`${to}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 13);
  // Arithmetic is on calendar components; converting back into a timezone can shift a day.
  return { from: start.toISOString().slice(0, 10), to };
}

export function prettyDate(value: string | null | undefined, timezone: string, withTime = false): string {
  if (!value) return 'Not yet';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return 'Not yet';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatter('UTC', 'date').format(parsed);
  return formatter(timezone, withTime ? 'dateTime' : 'date').format(parsed);
}

export function prettyTime(value: string, timezone: string): string {
  return formatter(timezone, 'time').format(new Date(value));
}
