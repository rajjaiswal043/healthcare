import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { loadEnv } from '../config/env.js';
import { EngagementService } from './engagement.service.js';

/**
 * The timer that sends due check-ins and late "time to leave" messages.
 *
 * A plain interval in the API process, not BullMQ, deliberately for now: one
 * API instance, nothing to retry (the console channel cannot fail), and every
 * pass is idempotent — a check-in is marked sent, a leave-now message is
 * stamped on the appointment. When there are two instances or a real provider,
 * this moves to a repeatable job on Memurai (ADR-006); the service it calls
 * does not change.
 *
 * `ENGAGEMENT_SWEEP_SECONDS=0` turns it off. The integration suite does, so no
 * test is ever racing a timer.
 */
@Injectable()
export class EngagementScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EngagementScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly engagement: EngagementService) {}

  onModuleInit(): void {
    const seconds = loadEnv().ENGAGEMENT_SWEEP_SECONDS;
    if (seconds <= 0) {
      this.logger.log('Patient messaging timer is off (ENGAGEMENT_SWEEP_SECONDS=0).');
      return;
    }

    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    // Never the reason the process stays alive.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    // A slow pass must not overlap the next one and double-send.
    if (this.running) return;
    this.running = true;
    try {
      const { checkins, leaveNow } = await this.engagement.sweep();
      if (checkins + leaveNow > 0) {
        this.logger.log(`Sent ${checkins} check-in(s) and ${leaveNow} time-to-leave message(s).`);
      }
    } finally {
      this.running = false;
    }
  }
}
