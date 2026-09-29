export class SessionExpired extends Error {
  constructor() { super('Your session has ended.'); this.name = 'SessionExpired'; }
}

export class ApiError extends Error {
  constructor(message: string) { super(message); this.name = 'ApiError'; }
}

export async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' }, signal, redirect: 'manual' });
  } catch {
    signal.throwIfAborted();
    throw new ApiError('The service could not be reached. Check your connection and try again.');
  }
  signal.throwIfAborted();
  if (response.type === 'opaqueredirect' || response.redirected || (response.status >= 300 && response.status < 400) || response.status === 401 || response.status === 403) {
    throw new SessionExpired();
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    if (response.status === 200 && contentType.includes('text/html')) throw new SessionExpired();
    throw new ApiError(`The service returned an unexpected response (HTTP ${response.status}). Try again.`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    signal.throwIfAborted();
    throw new ApiError('The service returned an unreadable response. Try again.');
  }
  signal.throwIfAborted();
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
    const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'The request could not be completed.';
    throw new ApiError(message);
  }
  return body as T;
}
