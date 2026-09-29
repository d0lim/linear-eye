import { describe, expect, it } from 'vitest';
import { verifyBearer } from '../src/auth/bearer';
import { health } from '../src/routes/health';

describe('HTTP boundaries', () => {
  it('health has no binding dependency', async () => {
    expect(await health().json()).toEqual({ status: 'ok', service: 'linear-eye' });
  });
  it('requires the exact bearer token and fails closed without configuration', async () => {
    const request = (authorization: string) => new Request('https://example.com/mcp', { headers: { authorization } });
    expect(await verifyBearer(request('Bearer secret'), 'secret')).toBe(true);
    expect(await verifyBearer(request('Bearer wrong'), 'secret')).toBe(false);
    expect(await verifyBearer(request('Basic secret'), 'secret')).toBe(false);
    expect(await verifyBearer(request('Bearer '), '')).toBe(false);
    expect(await verifyBearer(request('Bearer secret'), undefined)).toBe(false);
  });
});
