// Callers pass identifiers/counts only; never payloads, credentials, or API error bodies.
export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, event, ...fields }));
}
