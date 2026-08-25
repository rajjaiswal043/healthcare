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
