import 'reflect-metadata';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { MAX_DOCUMENT_BYTES } from './clinical/documents/documents.service.js';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { loadEnv } from './config/env.js';

/**
 * Builds the application, fully configured, but does not listen.
 *
 * This lives apart from main.ts so the integration tests get the SAME pipeline
 * the server runs: the validation pipe, the exception filter, the global
 * prefix, URI versioning, helmet and CORS. That is not tidiness — it is the
 * point of the tests. Every bug this branch produced lived in that pipeline
 * rather than in a service:
 *
 *   - CORS rejected every PATCH, because Fastify's method default is
 *     GET/HEAD/POST. The services were correct and the browser still could not
 *     reach them.
 *   - A PATCH with `Content-Type: application/json` and no body was refused by
 *     Fastify before any handler ran.
 *
 * A test harness that assembled its own Nest app would have reproduced neither.
 */
export async function createApiApp(): Promise<NestFastifyApplication> {
  const env = loadEnv();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Correlation id on every request, echoed in error responses and logs.
      genReqId: () => crypto.randomUUID(),
      trustProxy: true,
    }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));

  await app.register(helmet, {
    // The API serves JSON, never HTML, so a maximally restrictive CSP costs
    // nothing here. The web app sets its own.
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });

  /**
   * Multipart, for clinical documents only.
   *
   * The byte limit is set here as well as in the controller because this one is
   * enforced while the stream is being read: without it a caller can push
   * gigabytes at the process before any handler gets a chance to object.
   */
  await app.register(multipart, {
    limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 8 },
  });

  app.enableCors({
    // Explicit allow-list, never `*` — this API carries a session cookie, and
    // `credentials: true` with a wildcard origin is both invalid and dangerous.
    origin: [env.WEB_BASE_URL],
    credentials: true,

    /**
     * The methods must be listed explicitly.
     *
     * Fastify's CORS default is GET/HEAD/POST only, so every PATCH — check-in,
     * call, complete, cancel — was rejected at the browser's preflight with
     * "Method PATCH is not allowed". curl never noticed, because CORS is
     * enforced by the browser and not the server: the API was correct and the
     * app still could not talk to it.
     *
     * `cors.e2e.test.ts` asserts the preflight directly, which is the only way
     * to catch this without a browser.
     */
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown properties, and reject rather than ignore them: a request
      // carrying fields the API does not recognise is a request we do not
      // understand, and guessing is how mass-assignment bugs happen.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  return app;
}
