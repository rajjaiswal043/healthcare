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
   * Skips the authenticator on CLINIC sign-in, for local development.
   *
   * Started life as a seed-only flag — it set `requires_mfa = false` on seeded
   * roles — which covered the demo clinics and nothing else. A clinic created
   * through the platform console gets its roles from `SYSTEM_ROLES` directly, so
   * its administrator still met enrolment on first sign-in. Reading it here as
   * well makes one switch mean one thing: no authenticator on this machine.
   *
   * The seed still honours it too, so a re-seeded database is consistent with a
   * running API.
   */
  DEV_DISABLE_MFA: z
    .string()
    .optional()
    .transform((v) => /^(1|true|yes)$/i.test(v ?? '')),

  /**
   * Skips the authenticator on the PLATFORM sign-in, for local development.
   *
   * Read by the running API, unlike DEV_DISABLE_MFA which only ever reached the
   * seed script — so this one genuinely weakens live authentication, and is
   * treated accordingly:
   *
   *   - `loadEnv` refuses to start the API if it is set under
   *     NODE_ENV=production. Not ignored, not warned about: refused. A flag that
   *     silently downgrades auth in production is worse than no flag.
   *   - Every sign-in that uses it logs a warning naming the account.
   *
   * The platform account can create and suspend every clinic on the platform.
   * Turn this off before anyone else can reach the API.
   */
  DEV_DISABLE_PLATFORM_MFA: z
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
   * The one flag that must never survive a deploy.
   *
   * Checked here rather than at the call site so there is no way to reach the
   * platform login with it set in production — including through a code path
   * written next year by somebody who never read this file.
   */
  const disabled = [
    parsed.data.DEV_DISABLE_MFA ? 'DEV_DISABLE_MFA' : null,
    parsed.data.DEV_DISABLE_PLATFORM_MFA ? 'DEV_DISABLE_PLATFORM_MFA' : null,
  ].filter(Boolean);

  if (disabled.length > 0 && parsed.data.NODE_ENV === 'production') {
    throw new Error(
      `${disabled.join(' and ')} set with NODE_ENV=production.\n` +
        '  These skip two-factor on the accounts that manage a clinic and the platform.\n' +
        '  Remove them from the environment. The API will not start until you do.\n',
    );
  }

  cached = parsed.data;
  return cached;
}
