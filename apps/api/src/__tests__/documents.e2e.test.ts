/**
 * Clinical documents, over HTTP.
 *
 * One property carries this file: **the bucket is outside row-level security.**
 * Every other read in this system is protected by the database. Here Postgres
 * protects the ROW and the service protects the BYTES, by never letting a caller
 * name an object key.
 *
 * So the tests that matter are about keys and reach — that a key is always under
 * the caller's tenant prefix, that another clinic's document is indistinguishable
 * from one that does not exist, and that the type of a file is decided by its
 * bytes rather than by what the uploader called it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  closeTestApp,
  createTestApp,
  login,
  loginWithMfa,
  ownerQuery,
  seedFixtures,
  type Fixtures,
  type Session,
} from './harness.js';

let app: NestFastifyApplication;
let fx: Fixtures;
let doctor: Session;
let admin: Session;
let frontDesk: Session;
let otherAdmin: Session;

/** A real PDF, by signature. Four bytes is all the sniffer reads. */
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x00),
]);

/**
 * Build the multipart body with the platform's own FormData and Request.
 *
 * Node's globals rather than a library: `app.inject()` needs raw bytes and a
 * content-type carrying the boundary, and letting Request serialise the form is
 * the only way to be sure the two agree. Hand-rolling a boundary here would test
 * my multipart writing rather than the endpoint's multipart reading.
 */
async function upload(
  session: Session,
  patientId: string,
  bytes: Buffer,
  fileName = 'knee-ap.pdf',
) {
  const form = new FormData();
  form.set('file', new File([bytes], fileName));

  // Serialised through Request so undici builds the multipart boundary and
  // headers; app.inject() takes the raw body and content type from it.
  const request = new Request('http://localhost/upload', { method: 'POST', body: form });
  const payload = Buffer.from(await request.arrayBuffer());

  return app.inject({
    method: 'POST',
    url: `/api/v1/patients/${patientId}/documents`,
    headers: {
      cookie: session.cookie,
      'content-type': request.headers.get('content-type') as string,
    },
    payload,
  });
}

beforeAll(async () => {
  fx = await seedFixtures();
  app = await createTestApp();

  doctor = await login(app, fx.main.slug, 'doctor@main.test');
  frontDesk = await login(app, fx.main.slug, 'frontdesk@main.test');
  admin = await loginWithMfa(app, fx.main.slug, 'admin@main.test');
  otherAdmin = await loginWithMfa(app, fx.other.slug, 'admin@other.test');
});

afterAll(async () => {
  await closeTestApp(app);
});

beforeEach(async () => {
  await ownerQuery(fx.main.id, 'DELETE FROM clinical_document');
  await ownerQuery(fx.other.id, 'DELETE FROM clinical_document');

  // Audit rows accumulate across tests in this file, and two tests here count
  // them. A tolerance would pass while the code stopped auditing entirely.
  await ownerQuery(fx.main.id, `DELETE FROM audit_event WHERE action LIKE 'document.%'`);
});

describe('attaching a document', () => {
  it('stores a PDF and reports it back without the object key', async () => {
    const res = await upload(admin, fx.main.patientIds[0]!, PDF);

    expect(res.statusCode).toBe(201);
    const body = res.json<{ fileName: string; contentType: string; sizeBytes: number }>();
    expect(body.contentType).toBe('application/pdf');
    expect(body.sizeBytes).toBe(PDF.length);

    // The key never leaves the server. A response carrying it hands the client
    // the one thing this design keeps out of requests.
    expect(JSON.stringify(body)).not.toContain('tenants/');
    expect(JSON.stringify(body)).not.toContain('objectKey');
  });

  /**
   * The isolation boundary, asserted against the stored row rather than the
   * response — because the response deliberately does not show it.
   */
  it('writes a key under the calling tenant prefix, and nowhere else', async () => {
    await upload(admin, fx.main.patientIds[0]!, PDF);

    const [row] = await ownerQuery<{ object_key: string }>(
      fx.main.id,
      'SELECT object_key FROM clinical_document',
    );

    expect(row?.object_key).toMatch(
      new RegExp(`^tenants/${fx.main.id}/patients/${fx.main.patientIds[0]}/[0-9a-f-]{36}\\.pdf$`),
    );
  });

  /**
   * The type comes from the first bytes. A PDF called `.jpg` is stored as a PDF,
   * and a caller cannot make the server believe a file is something it is not.
   */
  it('decides the type from the bytes, not the filename', async () => {
    const res = await upload(admin, fx.main.patientIds[0]!, PDF, 'definitely-a-photo.jpg');

    expect(res.statusCode).toBe(201);
    expect(res.json<{ contentType: string }>().contentType).toBe('application/pdf');
  });

  it('accepts a PNG', async () => {
    const res = await upload(admin, fx.main.patientIds[0]!, PNG, 'xray.png');
    expect(res.statusCode).toBe(201);
    expect(res.json<{ contentType: string }>().contentType).toBe('image/png');
  });

  /**
   * A strict allow-list, not a deny-list. Unlike the clinic logo — which is
   * re-encoded to PNG and so cannot carry script whatever arrives — a 25MB
   * X-ray is stored as it came, so the type check is the only defence.
   */
  it('refuses a file that is not an accepted type', async () => {
    const res = await upload(
      admin,
      fx.main.patientIds[0]!,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      'sneaky.svg',
    );

    expect(res.statusCode).toBe(400);
    expect(res.payload).toMatch(/not a type we can store/i);
  });

  it('refuses an empty file', async () => {
    const res = await upload(admin, fx.main.patientIds[0]!, Buffer.alloc(0), 'nothing.pdf');
    expect(res.statusCode).toBe(400);
  });

  it('refuses a patient from another clinic', async () => {
    const res = await upload(admin, fx.other.patientIds[0]!, PDF);
    expect(res.statusCode).toBe(404);

    // And nothing was written to the bucket on the way to finding out — the
    // patient is confirmed before the bytes are stored.
    const rows = await ownerQuery(fx.other.id, 'SELECT id FROM clinical_document');
    expect(rows).toHaveLength(0);
  });

  it('refuses a caller without document:write', async () => {
    // The doctor reads films; the diagnostics role (checkpoint 2) attaches them.
    const res = await upload(doctor, fx.main.patientIds[0]!, PDF);
    expect(res.statusCode).toBe(403);
  });

  it('records the upload in the audit trail without the key', async () => {
    await upload(admin, fx.main.patientIds[0]!, PDF);

    const rows = await ownerQuery<{ action: string; changed_fields: string[] }>(
      fx.main.id,
      `SELECT action, changed_fields FROM audit_event WHERE action = 'document.upload'`,
    );

    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain('tenants/');
  });
});

describe('reading a document', () => {
  async function uploadedId(session: Session, patientId: string): Promise<string> {
    const res = await upload(session, patientId, PDF);
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  it('issues a short-lived url', async () => {
    const id = await uploadedId(admin, fx.main.patientIds[0]!);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${id}/url`,
      headers: { cookie: doctor.cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ url: string; expiresInSeconds: number; fileName: string }>();
    expect(body.expiresInSeconds).toBe(300);
    expect(body.fileName).toBe('knee-ap.pdf');

    /**
     * The suite runs on the in-memory store, which has no bucket to point at
     * and now answers with this API's own route rather than an unopenable
     * `memory://` placeholder. On S3 this is the signed bucket URL instead.
     *
     * The tenant no longer appears in the string, and it does not need to:
     * isolation was never enforced by what the URL spelled out. The next test
     * is the one that proves it, and `raw` below is held to the same rule.
     */
    expect(body.url).toBe(`/documents/${id}/raw`);
  });

  it('refuses to serve the bytes to another clinic', async () => {
    const id = await uploadedId(admin, fx.main.patientIds[0]!);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${id}/raw`,
      headers: { cookie: otherAdmin.cookie },
    });

    // Same answer as "no such document", for the same reason as everywhere
    // else here: under the tenant policy the two are one query result.
    expect(res.statusCode).toBe(404);
  });

  /**
   * The one that matters most. Another clinic's document must be
   * indistinguishable from one that does not exist — and it is, because under
   * the tenant policy the two are the same query result.
   */
  it("will not sign another clinic's document", async () => {
    const id = await uploadedId(otherAdmin, fx.other.patientIds[0]!);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${id}/url`,
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(404);

    const invented = await app.inject({
      method: 'GET',
      url: '/api/v1/documents/019fffff-0000-7000-8000-000000000000/url',
      headers: { cookie: admin.cookie },
    });

    // Same answer for "not yours" and "not real".
    expect(invented.statusCode).toBe(res.statusCode);
  });

  it('audits every read, because "who opened this X-ray" is asked afterwards', async () => {
    const id = await uploadedId(admin, fx.main.patientIds[0]!);

    await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${id}/url`,
      headers: { cookie: doctor.cookie },
    });

    const rows = await ownerQuery(
      fx.main.id,
      `SELECT id FROM audit_event WHERE action = 'document.read'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a caller without document:read', async () => {
    const id = await uploadedId(admin, fx.main.patientIds[0]!);

    // Seeded roles give front desk document:read, so use a session that has
    // neither: the other clinic's administrator is refused by tenancy anyway,
    // which is covered above. Here we assert the permission gate itself by
    // stripping it from the front desk's role for the length of the test.
    await ownerQuery(
      fx.main.id,
      `UPDATE role SET permissions = array_remove(permissions, 'document:read')
        WHERE key = 'front_desk'`,
    );

    try {
      const stripped = await login(app, fx.main.slug, 'frontdesk@main.test');
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/documents/${id}/url`,
        headers: { cookie: stripped.cookie },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await ownerQuery(
        fx.main.id,
        `UPDATE role SET permissions = array_append(permissions, 'document:read')
          WHERE key = 'front_desk' AND NOT ('document:read' = ANY (permissions))`,
      );
    }
  });
});

describe('listing a patient documents', () => {
  it('returns newest first and never the key', async () => {
    await upload(admin, fx.main.patientIds[0]!, PDF, 'first.pdf');
    await upload(admin, fx.main.patientIds[0]!, PNG, 'second.png');

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${fx.main.patientIds[0]}/documents`,
      headers: { cookie: frontDesk.cookie },
    });

    expect(res.statusCode).toBe(200);
    const { documents } = res.json<{ documents: Array<{ fileName: string }> }>();
    expect(documents.map((d) => d.fileName)).toEqual(['second.png', 'first.pdf']);
    expect(res.payload).not.toContain('tenants/');
  });

  it("does not show one clinic another's documents", async () => {
    await upload(otherAdmin, fx.other.patientIds[0]!, PDF);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/patients/${fx.other.patientIds[0]}/documents`,
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ documents: unknown[] }>().documents).toHaveLength(0);
  });
});
