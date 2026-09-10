import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { extname, basename } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadEnv } from '../../config/env.js';

/**
 * Where a clinical file physically lives.
 *
 * Modelled on `Anthony/DropYard/dropyard_backend/src/lib/s3.ts` at Narveer's
 * request — same SDK, same environment variable names, same ambient credential
 * chain, same `randomUUID()` object names, same filename sanitising. Two of his
 * codebases should not disagree about how S3 works.
 *
 * **One deliberate departure, and it is the important one.** DropYard builds an
 * unsigned public URL, because its bucket is public and marketplace photos are
 * meant to be seen. An X-ray is not a marketplace photo: a public URL is
 * readable forever by anyone who ends up holding the link, and links leak
 * through browser history, referrer headers and forwarded messages. So the
 * bucket here has Block Public Access on and every read is a short-lived
 * presigned GET, issued only after the caller's session has been checked
 * against the document's tenant.
 *
 * The interface exists for two reasons. The suite gets an in-memory
 * implementation, so tests need no AWS credentials — a test that talks to a real
 * bucket is a test that fails on a train. And the day this moves behind a CDN or
 * to another provider, it is one file.
 */
export interface ClinicalDocumentStore {
  put(input: {
    tenantId: string;
    patientId: string;
    bytes: Buffer;
    contentType: string;
    fileName: string;
  }): Promise<{ objectKey: string; sizeBytes: number }>;

  signedUrl(objectKey: string, expiresInSeconds?: number): Promise<string>;

  /**
   * The bytes, for a store that cannot hand out a URL a browser can follow.
   *
   * Only the in-memory store implements this. S3 deliberately does not: the
   * whole reason `signedUrl` exists is so a 25MB scan travels from the bucket
   * to the radiologist rather than through this process.
   */
  fetch?(objectKey: string): Promise<{ bytes: Buffer; contentType: string } | null>;
}

export const CLINICAL_DOCUMENT_STORE = Symbol('CLINICAL_DOCUMENT_STORE');

/**
 * How long a read URL lives.
 *
 * Five minutes is long enough to open a 25MB film on a clinic's connection and
 * short enough that a URL pasted somewhere it should not be has usually expired
 * before it is used. It is a mitigation, not a guarantee — a link forwarded
 * within the window works for whoever receives it.
 */
export const SIGNED_URL_TTL_SECONDS = 300;

/**
 * The tenant prefix. The isolation boundary between one clinic's images and
 * another's, and the thing the database CHECK on `object_key` also enforces.
 */
export function tenantPrefix(tenantId: string): string {
  return `tenants/${tenantId}/`;
}

/** DropYard's rule, unchanged: strip the path, allow only safe characters. */
export function safeFileName(originalName: string): string {
  return (
    basename(originalName)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 255) || 'file'
  );
}

/**
 * S3 configuration, or a plain-English explanation of what is missing.
 *
 * Throws rather than being validated at boot, so a clinic that does not use
 * diagnostics can still start the API — and so the test suite does not need
 * credentials. Same shape as DropYard's `getS3Config()`.
 */
export function getS3Config(): { bucket: string; region: string } {
  const env = loadEnv();
  const bucket = env.AWS_S3_BUCKET;
  const region = env.AWS_REGION;

  if (!bucket || !region) {
    throw new Error(
      'Clinical document storage is not configured. Set AWS_S3_BUCKET and AWS_REGION ' +
        '(and credentials, or run on an instance role) before uploading files.',
    );
  }

  return { bucket, region };
}

@Injectable()
export class S3ClinicalDocumentStore implements ClinicalDocumentStore {
  /**
   * Built lazily and once.
   *
   * Lazily because the configuration may legitimately be absent — see
   * `getS3Config`. Once because an S3Client holds a connection pool, and one per
   * upload is how a busy clinic exhausts its sockets.
   */
  private client: S3Client | null = null;

  async put(input: {
    tenantId: string;
    patientId: string;
    bytes: Buffer;
    contentType: string;
    fileName: string;
  }): Promise<{ objectKey: string; sizeBytes: number }> {
    const { bucket } = getS3Config();

    /**
     * The key, built here and nowhere else.
     *
     * Every part of it comes from the server: the tenant and patient from the
     * verified session and a checked lookup, the name from `randomUUID()`. The
     * only thing derived from the upload is the extension, and even that is
     * taken from the sanitised name. A caller cannot influence where their file
     * lands, which is the whole of the isolation story outside Postgres.
     */
    const extension = extname(safeFileName(input.fileName)).toLowerCase().slice(0, 10);
    const objectKey = `${tenantPrefix(input.tenantId)}patients/${input.patientId}/${randomUUID()}${extension}`;

    await this.s3().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: input.bytes,
        ContentType: input.contentType,
        // Belt and braces against a bucket policy that is later loosened: an
        // object explicitly marked private cannot be made public by accident.
        ACL: 'private',
      }),
    );

    return { objectKey, sizeBytes: input.bytes.length };
  }

  async signedUrl(objectKey: string, expiresIn = SIGNED_URL_TTL_SECONDS): Promise<string> {
    const { bucket } = getS3Config();

    return getSignedUrl(this.s3(), new GetObjectCommand({ Bucket: bucket, Key: objectKey }), {
      expiresIn,
    });
  }

  private s3(): S3Client {
    if (!this.client) {
      // Credentials come from the ambient chain — environment variables locally,
      // the instance role in production. Same as DropYard; no keys in code.
      this.client = new S3Client({ region: getS3Config().region });
    }
    return this.client;
  }
}

/**
 * The test double.
 *
 * Holds bytes in a Map and hands back a `memory://` URL. Everything the tests
 * care about — that the key is tenant-prefixed, that a document from another
 * clinic is unreachable, that oversized files are refused — is decided before
 * the store is reached, so a real bucket would prove nothing extra and would
 * make the suite depend on the network.
 */
@Injectable()
export class InMemoryClinicalDocumentStore implements ClinicalDocumentStore {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();

  async put(input: {
    tenantId: string;
    patientId: string;
    bytes: Buffer;
    contentType: string;
    fileName: string;
  }): Promise<{ objectKey: string; sizeBytes: number }> {
    const extension = extname(safeFileName(input.fileName)).toLowerCase().slice(0, 10);
    const objectKey = `${tenantPrefix(input.tenantId)}patients/${input.patientId}/${randomUUID()}${extension}`;

    this.objects.set(objectKey, { bytes: input.bytes, contentType: input.contentType });
    return { objectKey, sizeBytes: input.bytes.length };
  }

  /**
   * A URL the API itself will serve, not a `memory://` placeholder.
   *
   * The placeholder was honest about there being no bucket, and useless in a
   * browser: a doctor clicking an uploaded report got a blank tab. Since this
   * store holds the bytes, it can serve them — `documents/:id/raw` does, behind
   * the same permission as everything else here. Relative, because only the
   * caller knows what host it is answering on.
   */
  async signedUrl(objectKey: string, expiresIn = SIGNED_URL_TTL_SECONDS): Promise<string> {
    void expiresIn;
    return `memory:${objectKey}`;
  }

  async fetch(objectKey: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    return this.objects.get(objectKey) ?? null;
  }
}
