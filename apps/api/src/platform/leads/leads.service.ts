import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { loadEnv } from '../../config/env.js';
import type { CreateLeadDto } from './leads.controller.js';

const TOPIC_LABEL = { demo: 'Demo request', website: 'Website request' } as const;

/** Each accepted request sends an email, so the cap is far tighter than page reads. */
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 5;
const MAX_TRACKED = 5_000;

@Injectable()
export class LeadsService {
  private readonly log = new Logger(LeadsService.name);
  private readonly env = loadEnv();
  private transporter: Transporter | undefined;
  private readonly recent = new Map<string, { count: number; resetAt: number }>();

  async submit(dto: CreateLeadDto, ip = 'unknown'): Promise<void> {
    // Honeypot filled: a bot. Accept and drop, so it learns nothing.
    if (dto.website) return;

    this.throttle(`${ip}|${dto.email.toLowerCase()}`);

    const subject = `${TOPIC_LABEL[dto.topic]}: ${clean(dto.clinic)}`;
    const text = [
      `${TOPIC_LABEL[dto.topic]} from the DoctorDesk website`,
      '',
      `Name:   ${clean(dto.name)}`,
      `Clinic: ${clean(dto.clinic)}`,
      `Phone:  ${clean(dto.phone)}`,
      `Email:  ${clean(dto.email)}`,
      `City:   ${clean(dto.city)}`,
      `Notes:  ${dto.notes?.trim() ? dto.notes.trim() : '-'}`,
      '',
      `Received ${new Date().toISOString()}`,
    ].join('\n');

    if (this.env.MAIL_DRIVER === 'console') {
      this.log.log(
        `[MAIL_DRIVER=console] Would email ${this.env.LEADS_EMAIL_TO ?? '(LEADS_EMAIL_TO not set)'}\n` +
          `Subject: ${subject}\n${text}`,
      );
      return;
    }

    const to = this.env.LEADS_EMAIL_TO;
    if (!to || !this.env.MAIL_HOST) {
      this.log.error(
        'Lead received but LEADS_EMAIL_TO or MAIL_HOST is not set; it was not delivered.',
      );
      throw new ServiceUnavailableException({
        code: 'LEADS_NOT_CONFIGURED',
        message: 'Requests cannot be sent right now. Please call or email us directly.',
      });
    }

    try {
      await this.mailer().sendMail({
        from: this.env.MAIL_FROM ?? this.env.MAIL_USER ?? to,
        to,
        replyTo: dto.email,
        subject,
        text,
      });
    } catch (err) {
      this.log.error(`Sending lead email failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException({
        code: 'LEAD_SEND_FAILED',
        message: 'Your request could not be sent. Please try again in a few minutes.',
      });
    }
  }

  private mailer(): Transporter {
    this.transporter ??= createTransport({
      host: this.env.MAIL_HOST,
      port: this.env.MAIL_PORT,
      secure: this.env.MAIL_SECURE,
      ...(this.env.MAIL_USER
        ? { auth: { user: this.env.MAIL_USER, pass: this.env.MAIL_PASSWORD ?? '' } }
        : {}),
    });
    return this.transporter;
  }

  private throttle(key: string): void {
    const now = Date.now();
    const hit = this.recent.get(key);
    if (!hit || hit.resetAt <= now) {
      if (this.recent.size >= MAX_TRACKED) {
        const oldest = this.recent.keys().next().value;
        if (oldest !== undefined) this.recent.delete(oldest);
      }
      this.recent.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return;
    }
    hit.count += 1;
    if (hit.count > MAX_PER_WINDOW) {
      throw new HttpException(
        {
          code: 'TOO_MANY_REQUESTS',
          message: 'We already have your request. We will be in touch soon.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

/** One line, no control characters: keeps form input from reshaping the email. */
function clean(v: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}
