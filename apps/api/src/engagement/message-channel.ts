import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * Where a message to a patient actually goes.
 *
 * One implementation today, `console`, which writes the message to the API log
 * and reports it sent. A real WhatsApp provider needs the clinic's own Business
 * account and approved templates (BRD A-03, a customer onboarding task), so it
 * is a second class behind this interface when that exists — nothing that
 * decides WHAT to send changes.
 *
 * Kept deliberately small: `send` either returns a provider reference or
 * throws. Retry, templates and delivery receipts belong to the real provider
 * and to an outbox worker (ADR-006), not to this seam.
 */
export interface MessageChannel {
  readonly name: string;
  send(toMobile: string, body: string): Promise<{ providerRef: string }>;
}

export const MESSAGE_CHANNEL = Symbol('MESSAGE_CHANNEL');

/**
 * Prints the message, link included, so a developer can be the patient.
 *
 * The mobile number is masked in the log line — logs travel further than the
 * database does. The link is NOT masked: opening it is the whole point of
 * running locally, and the console channel never runs against real patients.
 */
export class ConsoleMessageChannel implements MessageChannel {
  readonly name = 'whatsapp';
  private readonly logger = new Logger('WhatsApp (console)');

  async send(toMobile: string, body: string): Promise<{ providerRef: string }> {
    const masked = `${toMobile.slice(0, 2)}xxx xxx${toMobile.slice(-2)}`;
    this.logger.log(`[whatsapp → ${masked}] ${body.replace(/\n/g, ' ⏎ ')}`);
    return { providerRef: `console-${randomUUID()}` };
  }
}
