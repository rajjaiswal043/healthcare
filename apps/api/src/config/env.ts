import { z } from 'zod';

/**
 * Environment contract.
 *
 * Validated at boot, before anything connects to anything. An app holding
 * patient data should refuse to start on a misconfiguration rather than run in
 * a half-configured state and discover the problem in production.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    // The application must connect as healthcloud_app. The owner role owns the
    // tables and is therefore exempt from its own RLS policies unless FORCE is
    // set — relying on that alone is one control too few (ADR-005).
    .refine((url) => !url.includes('healthcloud_owner'), {
      message:
        'DATABASE_URL uses healthcloud_owner. The API must connect as healthcloud_app so ' +
        'row-level security applies (ADR-005).',
    }),

  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),

  /**
   * S3, for clinical documents — X-rays, scanned reports, PDFs.
   *
   * Names match the DropYard implementation deliberately: Narveer runs both,
   * and two of his codebases disagreeing about what the S3 bucket variable is
   * called is a needless thing to remember.
   *
   * ALL OPTIONAL, and that is a decision rather than laziness. A clinic that
   * does not use diagnostics should not be unable to start because nobody has
   * created a bucket yet, and the integration suite must run on a laptop with
   * no AWS credentials. `S3ClinicalDocumentStore` throws a plain-English error
   * when it is actually called without them — the same shape as DropYard's
   * `getS3Config()`.
   */
  AWS_REGION: z.string().optional(),
  AWS_S3_BUCKET: z.string().optional(),
  /** For a CDN in front of the bucket later. Unused while reads are presigned. */
  S3_PUBLIC_BASE_URL: z.string().url().optional(),

  /**
   * Which clinical document store to bind.
   *
   * `memory` keeps uploaded bytes in a Map and is how the integration suite runs
   * without AWS credentials — a suite that needed a real bucket is a suite
   * nobody runs on a train.
   *
   * Declared as configuration rather than sniffed from NODE_ENV, deliberately.
   * This codebase already refuses to give the application a hidden notion of
   * "test mode" (see the DATABASE_URL note in `__tests__/setup-env.ts`): a
   * branch that only tests take is a branch nobody reviews. This is a named,
   * greppable choice — and `memory` LOSES EVERY FILE ON RESTART, so the parse
   * below refuses to start with it under NODE_ENV=production rather than
   * trusting anyone to notice.
   */
  CLINICAL_STORAGE_DRIVER: z.enum(['s3', 'memory']).default('s3'),

  // Signing keys. Length-checked because a short secret makes HMAC-SHA256
  // brute-forceable, and a default that "works" in dev is exactly how a weak
  // key reaches production.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),

  /**
   * Two-factor authentication, for clinic AND platform sign-in.
   *
   * **Off by default**, on Narveer's decision of 25 Aug 2026, while HealthCloud
   * is being demonstrated rather than used. The alternative — three separate
   * escape hatches, one of which refused to start in production — meant the
   * behaviour depended on which flags happened to be set in which environment,
   * and nobody could answer "is MFA on right now?" without reading three files.
   *
   * So: one switch, one answer, and the answer is logged at boot.
   *
   * The product still MODELS it. `SYSTEM_ROLES` marks the administrator and
   * owner roles as requiring TOTP, enrolment and verification are fully
   * implemented, and the integration suite turns this on so all of it keeps its
   * end-to-end test. Nothing was deleted; turning it back on is this one
   * variable.
   *
   * **This should be `true` before real clinics hold real patient data.** These
   * accounts read clinical records and move money, and a password is the only
   * thing in front of them until then.
   */
  MFA_ENABLED: z
    .string()
    .optional()
    .transform((v) => /^(1|true|yes)$/i.test(v ?? '')),

  /**
   * How often the API sends due recovery check-ins and late "time to leave"
   * messages — docs/10. `0` turns the timer off; the integration suite does, so
   * no test races it. Every pass is idempotent, so a short interval costs
   * queries, never duplicate messages.
   */
  ENGAGEMENT_SWEEP_SECONDS: z.coerce.number().int().min(0).default(120),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${issues}\n`);
  }

  /**
   * Say out loud whether two-factor is on.
   *
   * Printed once at boot rather than left to be inferred. The state this
   * replaced — several flags, one of which refused to start in production —
   * failed in a specific way: nobody could tell what was in force without
   * reading three files, so the answer drifted. A line in the startup log
   * cannot drift.
   */
  if (parsed.data.CLINICAL_STORAGE_DRIVER === 'memory' && parsed.data.NODE_ENV === 'production') {
    throw new Error(
      'CLINICAL_STORAGE_DRIVER=memory keeps clinical documents in memory and loses every ' +
        'one of them when the process restarts. It exists for the test suite. Refusing to ' +
        'start in production.',
    );
  }

  if (!parsed.data.MFA_ENABLED) {
    // eslint-disable-next-line no-console -- before Nest's logger exists
    console.warn(
      `[auth] MFA_ENABLED is off: every account signs in with a password alone` +
        `${parsed.data.NODE_ENV === 'production' ? ', INCLUDING IN PRODUCTION' : ''}. ` +
        `Set MFA_ENABLED=true to require an authenticator.`,
    );
  }

  cached = parsed.data;
  return cached;
}
