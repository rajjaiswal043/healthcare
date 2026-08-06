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

  cached = parsed.data;
  return cached;
}
