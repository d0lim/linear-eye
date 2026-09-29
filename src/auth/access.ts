import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { Env } from '../env';

export interface AccessIdentity { email: string; subject: string }
const resolvers = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function accessConfig(env: Env): { issuer: string; audience: string } | null {
  const domain = env.ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.ACCESS_AUD?.trim();
  if (!domain || !audience) return null;
  try {
    const url = new URL(domain.includes('://') ? domain : `https://${domain}`);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/i.test(url.hostname)) return null;
    return { issuer: url.origin, audience };
  } catch { return null; }
}

function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, details: {} } }, {
    status, headers: { 'Cache-Control': 'private, no-store' },
  });
}

/** Verify the signed assertion even when a request reaches a preview or workers.dev hostname directly. */
export async function authenticateAccess(request: Request, env: Env): Promise<AccessIdentity | Response> {
  const config = accessConfig(env);
  if (!config) return failure(503, 'ACCESS_NOT_CONFIGURED', 'Cloudflare Access is not configured');
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  const unauthorized = () => failure(401, 'UNAUTHORIZED', 'Cloudflare Access authentication is required');
  if (!assertion) return unauthorized();
  let keyServiceFailed = false;
  try {
    let resolver = resolvers.get(config.issuer);
    if (!resolver) {
      resolver = createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`));
      resolvers.set(config.issuer, resolver);
    }
    const { payload } = await jwtVerify(assertion, async (header, token) => {
      try { return await resolver(header, token); }
      catch (error) {
        // An unknown signing key is an invalid assertion; other resolver failures belong to the key service.
        keyServiceFailed = !(error instanceof errors.JWKSNoMatchingKey);
        throw error;
      }
    }, {
      algorithms: ['RS256'], issuer: config.issuer, audience: config.audience,
      requiredClaims: ['exp', 'sub', 'email'],
    });
    if (typeof payload.email !== 'string' || !payload.email.trim() || typeof payload.sub !== 'string' || !payload.sub.trim()) {
      return unauthorized();
    }
    return { email: payload.email, subject: payload.sub };
  } catch {
    // Assertion contents and upstream JWKS errors must not reach logs or responses.
    if (keyServiceFailed) return failure(503, 'ACCESS_UNAVAILABLE', 'Cloudflare Access verification is temporarily unavailable');
    return unauthorized();
  }
}
