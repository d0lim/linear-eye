import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src';

describe('dashboard asset routing', () => {
  it('redirects the root and app entry to the dashboard directory', async () => {
    for (const path of ['/', '/app']) {
      const response = await worker.fetch(new Request(`https://example.com${path}`), env, createExecutionContext());
      expect(response.status).toBe(308);
      expect(response.headers.get('location')).toBe('https://example.com/app/');
    }
  });
  it('serves assets under /app with a restricted content policy', async () => {
    const seen: string[] = [];
    const fetchAsset = vi.fn(async (request: Request) => {
      seen.push(new URL(request.url).pathname);
      return new Response('<html>linear-eye</html>', { headers: { 'Content-Type': 'text/html' } });
    });
    const bindings = { ...env, ASSETS: { fetch: fetchAsset } as unknown as Fetcher };
    const response = await worker.fetch(new Request('https://example.com/app/'), bindings, createExecutionContext());
    expect(response.status).toBe(200);
    expect(seen).toEqual(['/']);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    const script = await worker.fetch(new Request('https://example.com/app/assets/main.js'), bindings, createExecutionContext());
    expect(script.status).toBe(200);
    expect(seen.at(-1)).toBe('/assets/main.js');
  });
  it('keeps machine endpoints and unknown routes out of the asset fallback', async () => {
    const fetchAsset = vi.fn();
    const bindings = { ...env, ASSETS: { fetch: fetchAsset } as unknown as Fetcher };
    for (const [path, status] of [['/mcp', 401], ['/admin/sync/missing', 401], ['/missing', 404]] as const) {
      expect((await worker.fetch(new Request(`https://example.com${path}`), bindings, createExecutionContext())).status).toBe(status);
    }
    expect(fetchAsset).not.toHaveBeenCalled();
  });
  it('rejects writes to static application routes', async () => {
    const response = await worker.fetch(new Request('https://example.com/app/', { method: 'POST' }), env, createExecutionContext());
    expect(response.status).toBe(405);
  });
});
