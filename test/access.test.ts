import { env } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticateAccess } from '../src/auth/access';

let issuer: string;
let issuerNumber = 0;
const audience = 'dashboard-audience';
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true });
  jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
});
beforeEach(() => { issuer = `https://access-test-${++issuerNumber}.cloudflareaccess.com`; });
afterEach(() => { vi.restoreAllMocks(); });

function bindings() { return { ...env, ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience }; }
function jwks() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    expect(String(url)).toBe(`${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  });
}
async function token(overrides: JWTPayload = {}, kid = 'test-key') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: 'reader@example.com', sub: 'reader-id', iss: issuer,
    aud: [audience], iat: now, exp: now + 600, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid }).sign(keys.privateKey);
}
function request(assertion?: string, host = 'linear-eye.example.com') {
  return new Request(`https://${host}/api/bootstrap`, { headers: assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {} });
}
async function rejected(assertion: string) {
  jwks();
  const response = await authenticateAccess(request(assertion), bindings());
  expect(response).toBeInstanceOf(Response);
  expect((response as Response).status).toBe(401);
  expect((response as Response).headers.get('Cache-Control')).toContain('no-store');
  expect(await (response as Response).json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Cloudflare Access authentication is required', details: {} } });
}

describe('Cloudflare Access authentication', () => {
  it('verifies an RS256 signature from the configured JWKS and returns the human identity', async () => {
    jwks();
    expect(await authenticateAccess(request(await token()), bindings())).toEqual({ email: 'reader@example.com', subject: 'reader-id' });
  });

  it('does not trust an Access email header or an ordinary bearer token on any hostname', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const host of ['linear-eye.example.com', 'linear-eye.owner.workers.dev', 'preview-linear-eye.owner.workers.dev']) {
      const forged = new Request(`https://${host}/api/bootstrap`, { headers: {
        'Cf-Access-Authenticated-User-Email': 'reader@example.com', Authorization: `Bearer ${env.MCP_AUTH_TOKEN}`,
      } });
      const result = await authenticateAccess(forged, bindings());
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a valid signature for another application', async () => { await rejected(await token({ aud: 'other-app' })); });
  it('rejects a valid signature with another issuer', async () => { await rejected(await token({ iss: 'https://other.cloudflareaccess.com' })); });
  it('rejects expired and not-yet-valid assertions', async () => {
    await rejected(await token({ exp: Math.floor(Date.now() / 1000) - 60 }));
    vi.restoreAllMocks();
    await rejected(await token({ nbf: Math.floor(Date.now() / 1000) + 600 }));
  });
  it('requires expiration and both human identity claims', async () => {
    for (const overrides of [{ exp: undefined }, { email: undefined }, { sub: undefined }, { email: '' }, { sub: '' }]) {
      await rejected(await token(overrides));
      vi.restoreAllMocks();
    }
  });
  it('rejects a token signed by another private key even with the expected key identifier', async () => {
    const attacker = await generateKeyPair('RS256');
    const forged = await new SignJWT({ email: 'reader@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer).setAudience(audience).setSubject('reader-id').setExpirationTime('10m').sign(attacker.privateKey);
    await rejected(forged);
  });
  it('rejects an unknown signing key as an invalid assertion', async () => {
    const fetchSpy = jwks();
    const response = await authenticateAccess(request(await token({}, 'unknown-key')), bindings());
    expect((response as Response).status).toBe(401);
    expect(await (response as Response).json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(fetchSpy).toHaveBeenCalled();
  });
  it('rejects unsupported assertion algorithms without contacting the key service', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const assertion = await new SignJWT({ email: 'reader@example.com' }).setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer).setAudience(audience).setSubject('reader-id').setExpirationTime('10m')
      .sign(new Uint8Array(32));
    const response = await authenticateAccess(request(assertion), bindings());
    expect((response as Response).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it.each([
    ['network rejection', () => Promise.reject(new TypeError('private upstream details'))],
    ['timeout', () => Promise.reject(new DOMException('private upstream details', 'TimeoutError'))],
    ['non-200 response', async () => new Response('private upstream details', { status: 503 })],
    ['invalid JSON', async () => new Response('private upstream details')],
    ['malformed key set', async () => Response.json({ keys: 'private upstream details' })],
    ['invalid key material', async () => Response.json({ keys: [{ kty: 'RSA', kid: 'test-key', alg: 'RS256', use: 'sig' }] })],
  ] as const)('returns a sanitized retryable error for a JWKS %s', async (_label, fetchKeys) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchKeys);
    const assertion = await token();
    const response = await authenticateAccess(request(assertion), bindings());
    expect((response as Response).status).toBe(503);
    expect((response as Response).headers.get('Cache-Control')).toBe('private, no-store');
    expect(await (response as Response).json()).toEqual({ error: {
      code: 'ACCESS_UNAVAILABLE', message: 'Cloudflare Access verification is temporarily unavailable', details: {},
    } });
    expect(fetchSpy).toHaveBeenCalled();
  });
  it('recovers on retry after the JWKS service becomes available', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(Response.json({ keys: [jwk] }));
    const assertion = await token();
    expect((await authenticateAccess(request(assertion), bindings()) as Response).status).toBe(503);
    expect(await authenticateAccess(request(assertion), bindings())).toEqual({ email: 'reader@example.com', subject: 'reader-id' });
  });
  it('fails closed without valid trusted configuration before fetching any keys', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const config of [
      { ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: audience },
      { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: undefined },
      { ACCESS_TEAM_DOMAIN: 'http://access-test.cloudflareaccess.com', ACCESS_AUD: audience },
      { ACCESS_TEAM_DOMAIN: 'https://attacker.example', ACCESS_AUD: audience },
      { ACCESS_TEAM_DOMAIN: `${issuer}/wrong`, ACCESS_AUD: audience },
    ]) {
      const response = await authenticateAccess(request(await token()), { ...env, ...config });
      expect((response as Response).status).toBe(503);
      expect(await (response as Response).json()).toMatchObject({ error: { code: 'ACCESS_NOT_CONFIGURED' } });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
