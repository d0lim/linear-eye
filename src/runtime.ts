import { Layer } from 'effect';
import { databaseLayer } from './db/database';
import type { Env } from './env';
import { linearClientLayer } from './linear/client';
import { configLayer, queueLayer } from './services';

// Each entrypoint provides only the capabilities its program needs.
export const dataLayer = (env: Env) => Layer.merge(databaseLayer(env.DB), configLayer(env));
export const applicationLayer = (env: Env) => Layer.merge(dataLayer(env), queueLayer(env));
export const syncLayer = (env: Env) => Layer.merge(applicationLayer(env), linearClientLayer(env.LINEAR_API_KEY));
