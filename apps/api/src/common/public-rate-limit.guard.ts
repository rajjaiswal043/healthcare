import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * A per-IP cap for routes that answer without a session.
 *
 * Until branding, every read in this API was behind authentication, and the
 * only throttle anywhere was per-account login lockout. The branding endpoints
 * changed that: they answer anybody, by design, because the login page needs a
 * clinic's name before there is a session to authenticate.
 *
 * Two things that cap is for, in order of likelihood:
 *
 *   1. Somebody walking a wordlist of slugs. `BrandingService.resolve` already
 *      makes that useless by returning neutral branding for an unknown clinic —
 *      this makes it slow as well, so the attempt is expensive and visible.
 *   2. Somebody pulling logo bytes in a loop. The bytes come from Postgres, so
 *      an unbounded loop is database load, not just bandwidth.
 *
 * **In-memory, therefore per-process.** With one API instance that is the whole
 * story. The moment there are two, each gets its own counter and the effective
 * limit doubles — at which point this moves to Memurai, which is already
 * installed and running locally for exactly this class of job. Written as a
 * guard rather than a Fastify plugin so it stays scoped to the controllers that
 * opt in: a global limiter would sit in front of the clinic console, where a
 * busy front desk legitimately makes bursts of requests.
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 60;

/**
 * Bound on distinct IPs tracked at once, so the limiter cannot itself be turned
 * into a memory-exhaustion vector by a caller rotating source addresses.
 * Oldest window is dropped first; the effect of overflowing is a limiter that
 * forgets sooner, never one that allocates without end.
 */
const MAX_TRACKED_CLIENTS = 10_000;

interface Window {
  count: number;
  resetAt: number;
}

@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  private readonly windows = new Map<string, Window>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const key = req.ip || 'unknown';
    const now = Date.now();

    const existing = this.windows.get(key);

    if (!existing || existing.resetAt <= now) {
      this.evictIfCrowded();
      this.windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }

    existing.count += 1;

    if (existing.count > MAX_REQUESTS_PER_WINDOW) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));

      throw new HttpException(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests. Try again shortly.',
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
        { description: `retry after ${retryAfter}s` },
      );
    }

    return true;
  }

  /**
   * Drop expired windows, and if that was not enough, the oldest live ones.
   *
   * Called only when a new client appears, so the cost is amortised across the
   * requests that grow the map rather than paid on a timer that would keep the
   * process awake.
   */
  private evictIfCrowded(): void {
    if (this.windows.size < MAX_TRACKED_CLIENTS) return;

    const now = Date.now();
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }

    // Map preserves insertion order, so this drops least-recently-created.
    while (this.windows.size >= MAX_TRACKED_CLIENTS) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
  }
}
