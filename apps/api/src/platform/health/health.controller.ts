import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Public } from '../auth/decorators.js';

/**
 * Liveness and readiness.
 *
 * `/health/live`  — is the process up? Never touches the database, so a database
 *                   blip doesn't get the container killed and restarted into the
 *                   same blip.
 * `/health/ready` — can it actually serve traffic? Checks the database.
 */
// An orchestrator probing readiness has no session and no tenant.
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  async ready(): Promise<{ status: string; checks: Record<string, string> }> {
    const checks: Record<string, string> = {};
    let healthy = true;

    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch (err) {
      checks.database = err instanceof Error ? `failed: ${err.message}` : 'failed';
      healthy = false;
    }

    return { status: healthy ? 'ok' : 'degraded', checks };
  }
}
