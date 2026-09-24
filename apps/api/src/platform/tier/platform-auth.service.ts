import { Injectable, UnauthorizedException } from '@nestjs/common';
import { generateSecret, generateURI, verify as verifyOtp } from 'otplib';
import { PrismaService } from '../database/prisma.service.js';
import { hashPassword, needsRehash, verifyPassword } from '../auth/password.js';
import {
  generatePlatformRefreshToken,
  hashPlatformRefreshToken,
  signPlatformToken,
  PLATFORM_ACCESS_TTL_SECONDS,
  PLATFORM_REFRESH_TTL_SECONDS,
} from './platform-tokens.js';
import { loadEnv } from '../../config/env.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export interface PlatformLoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; fullName: string; email: string };
}

export interface PlatformMfaRequired {
  mfaRequired: true;
  enrolmentSecret?: string;
  otpauthUrl?: string;
}

interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

/**
 * Signing in as doctorsdesk.in.
 *
 * The same shape as the clinic's auth, with three deliberate differences:
 *
 *   - **MFA is not role-dependent.** On the clinic side it is a property of the
 *     role; here it applies to every account, because there is no version of an
 *     account that can provision or suspend every clinic on the platform and
 *     should be reachable with a password alone. It is nonetheless subject to
 *     the same `MFA_ENABLED` switch, which is currently off — see below.
 *   - **Lockout is tighter** — five attempts rather than eight. A handful of
 *     people use these accounts and none of them are typing on a busy front
 *     desk, so a lower threshold costs nothing and buys a lot.
 *   - **Sessions are short.** Ten minutes of access token, twelve hours of
 *     refresh. This is not a console anyone should be signed into all week.
 *
 * There is no tenant context anywhere in this file, and that is the point: it
 * reads `platform_user`, which is not tenant-scoped, and nothing else.
 */
@Injectable()
export class PlatformAuthService {
  constructor(private readonly prisma: PrismaService) {}

  async login(
    email: string,
    password: string,
    totpCode: string | undefined,
    meta: RequestMeta,
  ): Promise<PlatformLoginResult | PlatformMfaRequired> {
    const user = await this.prisma.client.platformUser.findFirst({
      where: { email: { equals: email.trim(), mode: 'insensitive' } },
    });

    if (!user) {
      // Spend comparable time, so a missing account is not faster than a wrong
      // password.
      await hashPassword(password);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordOk = await verifyPassword(password, user.passwordHash);

    if (!passwordOk || !user.isActive) {
      await this.recordFailure(user.id, user.failedLoginCount);
      throw new UnauthorizedException('Invalid credentials');
    }

    /**
     * The same single switch the clinic side reads (MFA_ENABLED), currently off.
     *
     * The platform account can create and suspend every clinic on the platform,
     * so this is the one most worth turning back on first — but a switch that
     * means different things in different realms is how the previous
     * arrangement became impossible to reason about.
     */
    if (!loadEnv().MFA_ENABLED) {
      return this.issue(user.id, user.email, user.fullName, user.passwordHash, password, meta);
    }

    const enrolled = Boolean(user.mfaSecret && user.mfaEnabledAt);

    if (!enrolled) {
      const secret = generateSecret();
      await this.prisma.client.platformUser.update({
        where: { id: user.id },
        data: { mfaSecret: secret },
      });

      return {
        mfaRequired: true,
        enrolmentSecret: secret,
        otpauthUrl: generateURI({ issuer: 'doctorsdesk.in platform', label: user.email, secret }),
      };
    }

    if (!totpCode) return { mfaRequired: true };

    const result = await verifyOtp({ token: totpCode, secret: user.mfaSecret as string });
    if (!result.valid) {
      await this.recordFailure(user.id, user.failedLoginCount);
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.issue(user.id, user.email, user.fullName, user.passwordHash, password, meta);
  }

  /** Completes first-time enrolment: verify the code, then activate it. */
  async confirmMfa(
    email: string,
    password: string,
    totpCode: string,
    meta: RequestMeta,
  ): Promise<PlatformLoginResult> {
    const user = await this.prisma.client.platformUser.findFirst({
      where: { email: { equals: email.trim(), mode: 'insensitive' } },
    });

    if (!user || !user.mfaSecret || !(await verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const result = await verifyOtp({ token: totpCode, secret: user.mfaSecret });
    if (!result.valid) throw new UnauthorizedException('Invalid code');

    await this.prisma.client.platformUser.update({
      where: { id: user.id },
      data: { mfaEnabledAt: new Date() },
    });

    return this.issue(user.id, user.email, user.fullName, user.passwordHash, password, meta);
  }

  /** Rotate. Reusing a spent token revokes the whole family, as on the clinic side. */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<PlatformLoginResult> {
    const existing = await this.prisma.client.platformSession.findUnique({
      where: { refreshTokenHash: hashPlatformRefreshToken(refreshToken) },
      include: { user: true },
    });

    if (!existing) throw new UnauthorizedException('Invalid session');

    if (existing.usedAt || existing.revokedAt) {
      // A spent token being presented again means it was captured. Kill every
      // session in the family rather than the one row.
      await this.prisma.client.platformSession.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Invalid session');
    }

    if (existing.expiresAt < new Date() || !existing.user.isActive) {
      throw new UnauthorizedException('Session expired');
    }

    await this.prisma.client.platformSession.update({
      where: { id: existing.id },
      data: { usedAt: new Date() },
    });

    return this.issue(
      existing.user.id,
      existing.user.email,
      existing.user.fullName,
      existing.user.passwordHash,
      null,
      meta,
      existing.familyId,
    );
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.client.platformSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(platformUserId: string) {
    const user = await this.prisma.client.platformUser.findUniqueOrThrow({
      where: { id: platformUserId },
      select: { id: true, email: true, fullName: true, lastLoginAt: true },
    });

    return user;
  }

  // --- internals -----------------------------------------------------------

  private async issue(
    id: string,
    email: string,
    fullName: string,
    storedHash: string,
    plainPassword: string | null,
    meta: RequestMeta,
    familyId?: string,
  ): Promise<PlatformLoginResult> {
    const env = loadEnv();
    const refreshToken = generatePlatformRefreshToken();

    const session = await this.prisma.client.platformSession.create({
      data: {
        platformUserId: id,
        refreshTokenHash: hashPlatformRefreshToken(refreshToken),
        familyId: familyId ?? crypto.randomUUID(),
        expiresAt: new Date(Date.now() + PLATFORM_REFRESH_TTL_SECONDS * 1000),
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      },
      select: { id: true },
    });

    await this.prisma.client.platformUser.update({
      where: { id },
      data: {
        lastLoginAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        // Opportunistic upgrade if hashing parameters have since been raised.
        ...(plainPassword && needsRehash(storedHash)
          ? { passwordHash: await hashPassword(plainPassword) }
          : {}),
      },
    });

    return {
      accessToken: signPlatformToken({ sub: id, psid: session.id }, env.JWT_ACCESS_SECRET),
      refreshToken,
      user: { id, fullName, email },
    };
  }

  private async recordFailure(id: string, current: number): Promise<void> {
    const next = current + 1;

    await this.prisma.client.platformUser.update({
      where: { id },
      data:
        next >= MAX_FAILED_ATTEMPTS
          ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000) }
          : { failedLoginCount: next },
    });
  }
}

export { PLATFORM_ACCESS_TTL_SECONDS, PLATFORM_REFRESH_TTL_SECONDS };
