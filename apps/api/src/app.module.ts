import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { DatabaseModule } from './platform/database/database.module.js';
import { HealthController } from './platform/health/health.controller.js';
import { AuthGuard } from './platform/auth/auth.guard.js';
import { AuthModule } from './platform/auth/auth.module.js';
import { PatientsModule } from './clinical/patients/patients.module.js';
import { ConsultationsModule } from './clinical/consultations/consultations.module.js';
import { SchedulingModule } from './scheduling/scheduling.module.js';
import { BillingModule } from './billing/billing.module.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.LOG_LEVEL,

        // Spread rather than `transport: undefined`. `exactOptionalPropertyTypes`
        // distinguishes "absent" from "explicitly undefined", and pino's types
        // only accept absent — which is the correct distinction, since passing
        // an explicit undefined transport is not the same as having none.
        ...(env.NODE_ENV === 'development'
          ? {
              transport: {
                target: 'pino-pretty',
                options: { singleLine: true, translateTime: 'HH:MM:ss' },
              },
            }
          : {}),

        // Never log a request body: in this system it is patient data.
        // Redact the headers that carry credentials, too.
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
          censor: '[redacted]',
        },

        // Health checks would otherwise dominate the log at info level.
        autoLogging: {
          ignore: (req) => req.url?.startsWith('/health') ?? false,
        },
      },
    }),
    DatabaseModule,
    AuthModule,
    PatientsModule,
    ConsultationsModule,
    SchedulingModule,
    BillingModule,
  ],
  controllers: [HealthController],
  providers: [
    // Authenticated and tenant-scoped by DEFAULT, everywhere. A route that
    // should be reachable without a session must say so with @Public(), which
    // is greppable — the inverse would mean a forgotten decorator silently
    // exposes patient data.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
