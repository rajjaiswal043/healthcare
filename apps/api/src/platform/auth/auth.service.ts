import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
// otplib v13 exposes a functional API — the v12 `authenticator` singleton is gone.
import { generateSecret, generateURI, verify as verifyOtp } from 'otplib';
import { PrismaService } from '../database/prisma.service.js';
import { logoVersionOf } from '../branding/logo-version.js';
import { AuditService } from '../audit/audit.service.js';
import { hashPassword, needsRehash, verifyPassword } from './password.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  tenantIdFromRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  ACCESS_TOKEN_TTL_SECONDS,
} from './tokens.js';
import { loadEnv } from '../../config/env.js';

/** Lock an account after this many consecutive failures. */
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  user: { id: string; fullName: string; permissions: string[]; mustChangePassword: boolean };
  tenant: { id: string; slug: string };
}

export interface MfaRequired {
  mfaRequired: true;
  /** Present only when the user must ENROL rather than merely present a code. */
  enrolmentSecret?: string;
  otpauthUrl?: string;
}

interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Authenticate.
   *
   * The single most important property here: every failure path returns the
   * SAME message and takes broadly the same time. "No such user", "wrong
   * password" and "inactive account" are indistinguishable to a caller, because
   * distinguishing them turns a login form into an account-enumeration oracle.
   */
  async login(
    tenantSlug: string,
    email: string,
    password: string,
    totpCode: string | undefined,
    meta: RequestMeta,
  ): Promise<LoginResult | MfaRequired> {
    const env = loadEnv();

    // Runs before tenant context exists — see auth_lookup_user in the migration
    // for why this one lookup is SECURITY DEFINER.
    const rows = await this.prisma.client.$queryRaw<
      Array<{
        user_id: string;
        tenant_id: string;
        password_hash: string;
        is_active: boolean;
        must_change_password: boolean;
        mfa_secret: string | null;
        mfa_enabled_at: Date | null;
        failed_login_count: number;
        locked_until: Date | null;
        full_name: string;
      }>
    >`SELECT * FROM auth_lookup_user(${tenantSlug}, ${email})`;

    const row = rows[0];

    if (!row) {
      // Spend comparable time so a missing account is not faster than a wrong
      // password. Without this, response latency reveals which emails exist.
      await hashPassword(password);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (row.locked_until && row.locked_until > new Date()) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordOk = await verifyPassword(password, row.password_hash);

    if (!passwordOk || !row.is_active) {
      await this.recordFailure(row.tenant_id, row.user_id, meta);
      throw new UnauthorizedException('Invalid credentials');
    }

    // --- MFA -----------------------------------------------------------------

    /**
     * Two-factor is a single switch (MFA_ENABLED), currently off.
     *
     * Skips enrolment AND the code prompt. Both halves matter: skipping only
     * enrolment would still prompt anybody who had already set an authenticator
     * up, which is how this looked broken the first time it was tried.
     *
     * Everything below this line still exists and is still tested — the suite
     * turns the switch on — so restoring it is one environment variable rather
     * than a rewrite.
     */
    if (!env.MFA_ENABLED) {
      return this.issueSession(row, password, meta, env);
    }

    const requiresMfa = await this.roleRequiresMfa(row.tenant_id, row.user_id);
    const enrolled = Boolean(row.mfa_secret && row.mfa_enabled_at);

    if (requiresMfa && !enrolled) {
      // Password was correct, but this role cannot proceed without MFA. Issue an
      // enrolment secret rather than a session — the account is not usable until
      // the user completes setup.
      const secret = generateSecret();
      await this.prisma.forTenant(row.tenant_id, (tx) =>
        tx.user.update({ where: { id: row.user_id }, data: { mfaSecret: secret } }),
      );

      return {
        mfaRequired: true,
        enrolmentSecret: secret,
        otpauthUrl: generateURI({
          issuer: `HealthCloud (${tenantSlug})`,
          label: email,
          secret,
        }),
      };
    }

    if (enrolled) {
      if (!totpCode) return { mfaRequired: true };

      const result = await verifyOtp({ token: totpCode, secret: row.mfa_secret as string });
      if (!result.valid) {
        await this.recordFailure(row.tenant_id, row.user_id, meta);
        throw new UnauthorizedException('Invalid credentials');
      }
    }

    // --- Success -------------------------------------------------------------
    return this.issueSession(row, password, meta, env);
  }

  /**
   * Everything that happens once authentication has actually succeeded.
   *
   * Extracted so the MFA path and the DEV_DISABLE_MFA path cannot drift: a
   * second copy of "record the login, rotate the session, write the audit entry"
   * is a place for one of them to forget the audit entry.
   */
  private async issueSession(
    row: {
      user_id: string;
      tenant_id: string;
      password_hash: string;
      must_change_password: boolean;
      full_name: string;
    },
    password: string,
    meta: RequestMeta,
    env: { JWT_ACCESS_SECRET: string },
  ): Promise<LoginResult> {
    const permissions = await this.permissionsFor(row.tenant_id, row.user_id);

    return this.prisma.forTenant(row.tenant_id, async (tx) => {
      // Opportunistic upgrade if hashing parameters have since been raised.
      const passwordUpdate = needsRehash(row.password_hash)
        ? { passwordHash: await hashPassword(password) }
        : {};

      await tx.user.update({
        where: { id: row.user_id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
          ...passwordUpdate,
        },
      });

      const { refreshToken, sessionId } = await this.createSession(
        tx,
        row.tenant_id,
        row.user_id,
        null,
        meta,
      );

      await this.audit.record(tx, row.tenant_id, {
        action: 'auth.login',
        resourceType: 'User',
        resourceId: row.user_id,
        actorUserId: row.user_id,
        actorLabel: row.full_name,
        changedFields: [],
        ...meta,
      });

      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: row.tenant_id },
        select: {
          id: true,
          slug: true,
          // The clinic's own identity, carried on the session so the console
          // can wear it without a second round trip. Under full white-label
          // this is what replaces our name in the header and the tab title.
          name: true,
          logoMimeType: true,
          logoUpdatedAt: true,
        },
      });

      return {
        accessToken: signAccessToken(
          { sub: row.user_id, tid: row.tenant_id, sid: sessionId, perms: permissions },
          env.JWT_ACCESS_SECRET,
        ),
        refreshToken,
        accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
        user: {
          id: row.user_id,
          fullName: row.full_name,
          permissions,
          mustChangePassword: row.must_change_password,
        },
        tenant: brandedTenant(tenant),
      };
    });
  }

  /** Completes first-time MFA enrolment: verify the code, then activate. */
  async confirmMfaEnrolment(
    tenantSlug: string,
    email: string,
    password: string,
    totpCode: string,
    meta: RequestMeta,
  ): Promise<LoginResult | MfaRequired> {
    const rows = await this.prisma.client.$queryRaw<
      Array<{
        user_id: string;
        tenant_id: string;
        password_hash: string;
        mfa_secret: string | null;
      }>
    >`SELECT * FROM auth_lookup_user(${tenantSlug}, ${email})`;

    const row = rows[0];
    if (!row || !(await verifyPassword(password, row.password_hash)) || !row.mfa_secret) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const result = await verifyOtp({ token: totpCode, secret: row.mfa_secret });
    if (!result.valid) {
      throw new UnauthorizedException('Invalid code');
    }

    await this.prisma.forTenant(row.tenant_id, (tx) =>
      tx.user.update({ where: { id: row.user_id }, data: { mfaEnabledAt: new Date() } }),
    );

    return this.login(tenantSlug, email, password, totpCode, meta);
  }

  /**
   * Rotate a refresh token.
   *
   * Reuse detection: presenting a token that has already been used means it was
   * captured — the legitimate client would have moved on to the replacement. In
   * that case every session in the family is revoked, turning a silent long-lived
   * compromise into a forced logout somebody notices and reports.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<LoginResult> {
    const env = loadEnv();
    const tokenHash = hashRefreshToken(refreshToken);

    // The tenant comes from the token's prefix, which lets us set context BEFORE
    // reading the session table. Nothing here bypasses row-level security: the
    // lookup happens inside the tenant's own policy, so a token cannot reach
    // another tenant's session even if the hash somehow collided.
    const tenantId = tenantIdFromRefreshToken(refreshToken);
    if (!tenantId) throw new UnauthorizedException('Invalid session');

    const existing = await this.prisma.forTenant(tenantId, (tx) =>
      tx.session.findUnique({
        where: { refreshTokenHash: tokenHash },
        select: {
          id: true,
          tenantId: true,
          userId: true,
          familyId: true,
          expiresAt: true,
          usedAt: true,
          revokedAt: true,
        },
      }),
    );

    if (!existing) throw new UnauthorizedException('Invalid session');

    if (existing.usedAt || existing.revokedAt) {
      this.logger.warn(
        { familyId: existing.familyId, userId: existing.userId },
        'Refresh token reuse detected — revoking the whole session family',
      );

      await this.prisma.forTenant(existing.tenantId, async (tx) => {
        await tx.session.updateMany({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'refresh_token_reuse' },
        });

        await this.audit.record(tx, existing.tenantId, {
          action: 'auth.refresh_reuse_detected',
          resourceType: 'Session',
          resourceId: existing.id,
          actorUserId: existing.userId,
          changedFields: [],
          ...meta,
        });
      });

      throw new UnauthorizedException('Invalid session');
    }

    if (existing.expiresAt < new Date()) throw new UnauthorizedException('Session expired');

    const permissions = await this.permissionsFor(existing.tenantId, existing.userId);

    return this.prisma.forTenant(existing.tenantId, async (tx) => {
      await tx.session.update({ where: { id: existing.id }, data: { usedAt: new Date() } });

      const { refreshToken: nextToken, sessionId } = await this.createSession(
        tx,
        existing.tenantId,
        existing.userId,
        existing.familyId,
        meta,
      );

      const user = await tx.user.findUniqueOrThrow({
        where: { id: existing.userId },
        select: { fullName: true, mustChangePassword: true, isActive: true },
      });

      if (!user.isActive) throw new UnauthorizedException('Invalid session');

      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: existing.tenantId },
        select: { id: true, slug: true },
      });

      return {
        accessToken: signAccessToken(
          { sub: existing.userId, tid: existing.tenantId, sid: sessionId, perms: permissions },
          env.JWT_ACCESS_SECRET,
        ),
        refreshToken: nextToken,
        accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
        user: {
          id: existing.userId,
          fullName: user.fullName,
          permissions,
          mustChangePassword: user.mustChangePassword,
        },
        tenant,
      };
    });
  }

  async logout(tenantId: string, sessionId: string, meta: RequestMeta): Promise<void> {
    await this.prisma.forTenant(tenantId, async (tx) => {
      const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { familyId: true, userId: true },
      });
      if (!session) return;

      // Revoke the whole family, not just this token: logging out should end the
      // session, not merely invalidate the newest link in its rotation chain.
      await tx.session.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'logout' },
      });

      await this.audit.record(tx, tenantId, {
        action: 'auth.logout',
        resourceType: 'Session',
        resourceId: sessionId,
        actorUserId: session.userId,
        changedFields: [],
        ...meta,
      });
    });
  }

  /** Active sessions for the device list (FR-USR-03). */
  async listSessions(tenantId: string, userId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.session.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, issuedAt: true, expiresAt: true, ipAddress: true, userAgent: true },
        orderBy: { issuedAt: 'desc' },
      }),
    );
  }

  // --- internals -----------------------------------------------------------

  private async createSession(
    tx: Parameters<Parameters<PrismaService['forTenant']>[1]>[0],
    tenantId: string,
    userId: string,
    familyId: string | null,
    meta: RequestMeta,
  ): Promise<{ refreshToken: string; sessionId: string }> {
    const refreshToken = generateRefreshToken(tenantId);

    const session = await tx.session.create({
      data: {
        tenantId,
        userId,
        refreshTokenHash: hashRefreshToken(refreshToken),
        familyId: familyId ?? crypto.randomUUID(),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      },
      select: { id: true },
    });

    return { refreshToken, sessionId: session.id };
  }

  /**
   * Change your own password.
   *
   * The current password is required even though the caller already holds a
   * valid session: a session is proof somebody was authenticated once, not proof
   * they are still the account's owner. An unattended desk is the ordinary case
   * in a clinic, and without this check anyone walking past a signed-in machine
   * owns that account permanently.
   *
   * Every OTHER session is ended. If the reason for the change is that somebody
   * else knew the old password, leaving their session alive achieves nothing.
   */
  async changePassword(
    tenantId: string,
    userId: string,
    sessionId: string,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.prisma.forTenant(tenantId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { passwordHash: true, fullName: true },
      });

      if (!(await verifyPassword(currentPassword, user.passwordHash))) {
        throw new UnauthorizedException('That is not your current password.');
      }

      if (await verifyPassword(newPassword, user.passwordHash)) {
        throw new BadRequestException({
          code: 'PASSWORD_UNCHANGED',
          message: 'Choose a password you have not just been using.',
        });
      }

      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash: await hashPassword(newPassword),
          // The whole point of the temporary password: it stops being required
          // the moment a real one is set.
          mustChangePassword: false,
        },
      });

      await tx.session.updateMany({
        where: { userId, revokedAt: null, id: { not: sessionId } },
        data: { revokedAt: new Date() },
      });

      await this.audit.record(tx, tenantId, {
        action: 'auth.password_change',
        resourceType: 'User',
        resourceId: userId,
        actorUserId: userId,
        actorLabel: user.fullName,
        changedFields: ['passwordHash'],
        ...meta,
      });
    });
  }

  /**
   * Who is signed in — name and roles, for the console's own chrome.
   *
   * A database read rather than more claims in the access token. The token is
   * verified on EVERY request and carries permissions because the guard needs
   * them on the hot path; a display name and role labels are read once when the
   * console loads, so putting them in the token would pay for them on every
   * request to save one query per page load. It also keeps a renamed user or a
   * changed role from being stale for the life of a token.
   */
  async profile(
    tenantId: string,
    userId: string,
  ): Promise<{
    fullName: string;
    roles: Array<{ key: string; name: string }>;
    mustChangePassword: boolean;
    tenant: BrandedTenant;
    /** Set when this user IS a bookable doctor. Null for everybody else. */
    practitionerId: string | null;
  }> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          fullName: true,
          mustChangePassword: true,
          roles: { select: { role: { select: { key: true, name: true } } } },
        },
      });

      /**
       * Read on every /auth/me, not only at login.
       *
       * The console shows the clinic's name and logo in its chrome, and an
       * administrator who changes either should see it after a refresh rather
       * than after signing out. Same argument that put `mustChangePassword`
       * here rather than only in the login response.
       */
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          id: true,
          slug: true,
          name: true,
          logoMimeType: true,
          logoUpdatedAt: true,
        },
      });

      /**
       * The practitioner this user is, if any.
       *
       * A doctor's user account and their bookable practitioner record are two
       * different rows — a distinction that cost an afternoon when a clinic was
       * onboarded and the booking screen showed no doctors. This is the link,
       * and it is what scopes the queue: a doctor sees their own list, not the
       * whole clinic's.
       */
      const practitioner = await tx.practitioner.findFirst({
        where: { userId },
        select: { id: true },
      });

      return {
        fullName: user.fullName,
        roles: user.roles.map((r) => r.role),
        mustChangePassword: user.mustChangePassword,
        tenant: brandedTenant(tenant),
        practitionerId: practitioner?.id ?? null,
      };
    });
  }

  private async permissionsFor(tenantId: string, userId: string): Promise<string[]> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const assignments = await tx.userRole.findMany({
        where: { userId },
        select: { role: { select: { permissions: true } } },
      });

      return [...new Set(assignments.flatMap((a) => a.role.permissions))].sort();
    });
  }

  private async roleRequiresMfa(tenantId: string, userId: string): Promise<boolean> {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const count = await tx.userRole.count({ where: { userId, role: { requiresMfa: true } } });
      return count > 0;
    });
  }

  private async recordFailure(tenantId: string, userId: string, meta: RequestMeta): Promise<void> {
    await this.prisma.forTenant(tenantId, async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true, fullName: true },
      });

      if (user.failedLoginCount >= MAX_FAILED_ATTEMPTS) {
        await tx.user.update({
          where: { id: userId },
          data: {
            lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000),
            failedLoginCount: 0,
          },
        });
      }

      await this.audit.record(tx, tenantId, {
        action: 'auth.login_failed',
        resourceType: 'User',
        resourceId: userId,
        actorUserId: userId,
        actorLabel: user.fullName,
        changedFields: [],
        ...meta,
      });
    });
  }
}

/** What the console needs to wear a clinic's identity. */
export interface BrandedTenant {
  id: string;
  slug: string;
  name: string;
  /** Null when the clinic has no logo of its own and the default applies. */
  logoVersion: string | null;
}

function brandedTenant(row: {
  id: string;
  slug: string;
  name: string;
  logoMimeType: string | null;
  logoUpdatedAt: Date | null;
}): BrandedTenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    logoVersion: row.logoMimeType ? logoVersionOf(row.logoUpdatedAt) : null,
  };
}
