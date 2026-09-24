// MUST be first: loads .env as a side effect before any module that reads
// process.env at import time is evaluated. Imports are hoisted, so ordering
// here is load-bearing, not cosmetic.
import './config/load-dotenv.js';

import { createApiApp } from './bootstrap.js';
import { loadEnv } from './config/env.js';

/**
 * Server entry point.
 *
 * Everything about HOW the app is configured lives in bootstrap.ts, so the
 * integration tests can build the identical application without listening on a
 * port. All that is left here is the listening itself.
 */
async function bootstrap(): Promise<void> {
  const app = await createApiApp();
  await app.listen({ port: loadEnv().API_PORT, host: '0.0.0.0' });
}

void bootstrap();
