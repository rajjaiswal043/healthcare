/**
 * CORS preflight.
 *
 * This file exists because of one bug, and it is worth stating plainly.
 *
 * Fastify's default CORS method list is GET, HEAD and POST. Every state change
 * in the queue — check-in, call, complete, cancel, reschedule — is a PATCH, so
 * the browser's preflight was answered with a method list that did not include
 * it and the request was never sent. The API was correct. Every endpoint
 * returned 200 to curl. The app simply could not talk to it.
 *
 * CORS is enforced by the BROWSER, not the server, so no ordinary request test
 * can catch this: injecting a PATCH directly succeeds either way. The preflight
 * itself is the only thing that reveals it, which is what these assertions
 * drive.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { closeTestApp, createTestApp } from './harness.js';

const WEB_ORIGIN = process.env.WEB_BASE_URL ?? 'http://localhost:3000';

let app: NestFastifyApplication;

// No fixtures. A preflight is answered before routing, so it never reaches a
// handler, a guard or the database — seeding here would only add seconds.
beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await closeTestApp(app);
});

function preflight(method: string, origin = WEB_ORIGIN) {
  return app.inject({
    method: 'OPTIONS',
    url: '/api/v1/appointments/01930000-0000-7000-8000-0000000000ff/check-in',
    headers: {
      origin,
      'access-control-request-method': method,
      'access-control-request-headers': 'content-type',
    },
  });
}

describe('preflight from the staff console', () => {
  it('allows every method the queue board uses', async () => {
    // PATCH first, and named individually rather than in a loop, so a failure
    // says which verb broke rather than "one of five".
    for (const method of ['PATCH', 'POST', 'GET', 'DELETE', 'PUT']) {
      const res = await preflight(method);

      expect(res.statusCode, `preflight for ${method}`).toBeLessThan(300);

      const allowed = String(res.headers['access-control-allow-methods'] ?? '');
      expect(allowed, `allow-methods for ${method}`).toContain(method);
    }
  });

  it('echoes the console origin and permits credentials', async () => {
    const res = await preflight('PATCH');

    // The session travels in a cookie, so without this the browser discards the
    // response even when the request itself succeeds.
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('allows the headers the client actually sends', async () => {
    const res = await preflight('POST');
    const allowed = String(res.headers['access-control-allow-headers'] ?? '');

    expect(allowed.toLowerCase()).toContain('content-type');
    expect(allowed.toLowerCase()).toContain('authorization');
  });
});

describe('preflight from anywhere else', () => {
  it('does not hand an allow-origin header to an unknown site', async () => {
    const res = await preflight('PATCH', 'https://evil.example.com');

    // The allow-list is explicit and never `*`: an API carrying a session cookie
    // with a wildcard origin is both invalid per the spec and dangerous.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
