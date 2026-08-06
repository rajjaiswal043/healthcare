// MUST be first: loads .env as a side effect before any module that reads
// process.env at import time is evaluated. Imports are hoisted, so ordering
// here is load-bearing, not cosmetic.
import './config/load-dotenv.js';

import 'reflect-metadata';
import helmet from '@fastify/helmet';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
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

  // Explicit origin allow-list. Never `origin: '*'` on an authenticated API.
  app.enableCors({
    origin: [env.WEB_BASE_URL],
    credentials: true,
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

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
}

void bootstrap();
