import { Data } from 'effect';

export class AppError extends Data.TaggedError('AppError')<{
  code: string; message: string; details?: Record<string, unknown>;
}> {}
export class DatabaseError extends Data.TaggedError('DatabaseError')<{ operation: string }> {}
export class QueueOfferError extends Data.TaggedError('QueueOfferError')<{}> {}
export class LinearApiError extends Data.TaggedError('LinearApiError')<{
  status: number; retryable: boolean; retryAfterSeconds?: number;
}> {}
export class WebhookSignatureError extends Data.TaggedError('WebhookSignatureError')<{}> {}
export class WebhookTimestampError extends Data.TaggedError('WebhookTimestampError')<{}> {}
export class WebhookDecodeError extends Data.TaggedError('WebhookDecodeError')<{}> {}

export function errorResult(error: unknown) {
  return { error: error instanceof AppError
    ? { code: error.code, message: error.message, details: error.details ?? {} }
    : { code: 'INTERNAL_ERROR', message: 'An internal error occurred', details: {} } };
}
