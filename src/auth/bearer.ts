export async function verifyBearer(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return false;
  const encoder = new TextEncoder();
  const [supplied, wanted] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(header.slice(7))),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(supplied), b = new Uint8Array(wanted);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  return different === 0;
}

export const unauthorized = () => Response.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized', details: {} } }, {
  status: 401, headers: { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' },
});
