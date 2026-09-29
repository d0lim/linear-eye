import { startSync } from './full-sync';

// Cloudflare Cron supplies durable scheduling; the program only enqueues work.
export const startReconcile = () => startSync('reconcile');
