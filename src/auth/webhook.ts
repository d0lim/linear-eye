import { Effect } from 'effect';
import { WebhookSignatureError, WebhookTimestampError } from '../errors';

export function isFreshWebhookTimestamp(timestamp: number, now: number): boolean {
  return Number.isSafeInteger(timestamp) && timestamp > 0 && Math.abs(now - timestamp) <= 60_000;
}

/** Verify the exact received bytes before decoding any attacker-controlled JSON. */
export const verifyWebhook = (rawBody: ArrayBuffer, headers: Headers, secret: string, now: number) =>
  Effect.gen(function* () {
    const signature = headers.get('Linear-Signature');
    if (!secret || !signature || !/^[a-fA-F0-9]{64}$/.test(signature)) {
      return yield* Effect.fail(new WebhookSignatureError());
    }
    const bytes = Uint8Array.from(signature.match(/../g)!, (byte) => Number.parseInt(byte, 16));
    const valid = yield* Effect.tryPromise({
      try: async () => {
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
          { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        return crypto.subtle.verify('HMAC', key, bytes, rawBody);
      },
      catch: () => new WebhookSignatureError(),
    });
    if (!valid) return yield* Effect.fail(new WebhookSignatureError());
    const timestamp = headers.get('Linear-Timestamp');
    if (!timestamp || !/^\d+$/.test(timestamp) || !isFreshWebhookTimestamp(Number(timestamp), now)) {
      return yield* Effect.fail(new WebhookTimestampError());
    }
  });
