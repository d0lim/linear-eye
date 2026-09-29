import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getJson, SessionExpired } from '../web/src/api';
import { dateInZone, defaultDateRange, prettyDate } from '../web/src/dates';

afterEach(() => vi.restoreAllMocks());

describe('dashboard calendar dates', () => {
  it('preserves selected dates and milestone targets west of UTC', () => {
    expect(prettyDate('2026-09-29', 'America/Los_Angeles')).toBe('Sep 29, 2026');
    expect(prettyDate('2026-10-01', 'America/Los_Angeles')).toBe('Oct 1, 2026');
  });

  it('converts timestamps into the report timezone', () => {
    const timestamp = '2026-09-29T01:00:00Z';
    expect(prettyDate(timestamp, 'America/Los_Angeles')).toBe('Sep 28, 2026');
    expect(prettyDate(timestamp, 'Asia/Seoul')).toBe('Sep 29, 2026');
    expect(dateInZone(new Date(timestamp), 'America/Los_Angeles')).toBe('2026-09-28');
  });

  it.each([
    ['Pacific/Kiritimati', '2026-09-29T15:00:00Z', '2026-09-17', '2026-09-30'],
    ['America/Los_Angeles', '2026-09-29T01:00:00Z', '2026-09-15', '2026-09-28'],
    ['America/Los_Angeles', '2026-03-09T12:00:00Z', '2026-02-24', '2026-03-09'],
    ['America/Los_Angeles', '2026-11-02T12:00:00Z', '2026-10-20', '2026-11-02'],
  ])('selects fourteen calendar days in %s at %s', (timezone, now, from, to) => {
    expect(defaultDateRange(new Date(now), timezone)).toEqual({ from, to });
  });
});

describe('dashboard API failures', () => {
  const signal = () => new AbortController().signal;

  it.each([
    [503, 'text/html', '<html>private upstream diagnostic</html>'],
    [502, 'text/plain', 'private upstream diagnostic'],
    [404, 'text/html', '<html>Missing</html>'],
  ])('keeps a non-JSON HTTP %s response retryable', async (status, contentType, body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status, headers: { 'Content-Type': contentType } }));
    const error = await getJson('/api/changes', signal()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(SessionExpired);
    expect((error as Error).message).toContain(`HTTP ${status}`);
    expect((error as Error).message).not.toContain('private upstream');
  });

  it.each([401, 403, 302])('requests a new sign-in for HTTP %s', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
    await expect(getJson('/api/changes', signal())).rejects.toBeInstanceOf(SessionExpired);
  });

  it('recognizes an HTML sign-in page with a successful status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
    await expect(getJson('/api/changes', signal())).rejects.toBeInstanceOf(SessionExpired);
  });

  it('sanitizes malformed JSON as a retryable failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{ private upstream diagnostic', { headers: { 'Content-Type': 'application/json' } }));
    const error = await getJson('/api/changes', signal()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).toBe('The service returned an unreadable response. Try again.');
  });

  it('preserves a JSON service error without expiring the session', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { message: 'Sign-in verification is temporarily unavailable.' } }, { status: 503 }));
    await expect(getJson('/api/changes', signal())).rejects.toEqual(new ApiError('Sign-in verification is temporarily unavailable.'));
  });

  it('preserves aborts even when a canceled request returns an authentication response', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort();
      return new Response(null, { status: 401 });
    });
    await expect(getJson('/api/changes', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('sanitizes network errors without expiring the session', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private network diagnostic'));
    await expect(getJson('/api/changes', signal())).rejects.toEqual(new ApiError('The service could not be reached. Check your connection and try again.'));
  });
});
