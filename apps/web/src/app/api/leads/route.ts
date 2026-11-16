/* eslint-disable no-console -- a serverless function's console is its log: it shows in Netlify's function logs */
import { createTransport, type Transporter } from 'nodemailer';

/**
 * POST /api/leads — "Request a demo" / "Request a website" from the welcome
 * page, emailed to the company inbox.
 *
 * Lives in the web app (not the NestJS API) so the marketing page works on
 * Netlify on its own: Netlify runs this as a serverless function, and the only
 * setup is the MAIL_* and LEADS_EMAIL_TO environment variables on the site.
 * Locally they are read from the repo-root .env (see next.config.mjs).
 *
 * MAIL_DRIVER=console prints the email instead of sending it.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOPIC_LABEL = { demo: 'Demo request', website: 'Website request' } as const;
type Topic = keyof typeof TOPIC_LABEL;

/** Per-IP cap. Per function instance on Netlify, so a speed bump, not a wall. */
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 5;
const recent = new Map<string, { count: number; resetAt: number }>();

let transporter: Transporter | undefined;

function fail(status: number, code: string, message: string) {
  return Response.json({ error: { code, message, correlationId: 'web-leads' } }, { status });
}

/** One line, no control characters: keeps form input from reshaping the email. */
function clean(v: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

function str(body: Record<string, unknown>, key: string, max: number): string {
  const v = body[key];
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function throttled(ip: string): boolean {
  const now = Date.now();
  const hit = recent.get(ip);
  if (!hit || hit.resetAt <= now) {
    if (recent.size > 5_000) recent.clear();
    recent.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  hit.count += 1;
  return hit.count > MAX_PER_WINDOW;
}

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, 'BAD_REQUEST', 'Please check your details and try again.');
  }

  // Honeypot filled: a bot. Accept and drop, so it learns nothing.
  if (str(body, 'website', 200)) return Response.json({ status: 'received' }, { status: 202 });

  const topic = body.topic === 'website' ? 'website' : body.topic === 'demo' ? 'demo' : null;
  const lead = {
    name: str(body, 'name', 120),
    clinic: str(body, 'clinic', 160),
    phone: str(body, 'phone', 20),
    email: str(body, 'email', 255),
    city: str(body, 'city', 80),
    notes: str(body, 'notes', 1000),
  };
  const invalid =
    !topic ||
    lead.name.length < 2 ||
    lead.clinic.length < 2 ||
    lead.city.length < 2 ||
    !/^[+0-9 ()-]{10,16}$/.test(lead.phone) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email);
  if (invalid) return fail(400, 'BAD_REQUEST', 'Please check your details and try again.');

  const ip =
    req.headers.get('x-nf-client-connection-ip') ?? req.headers.get('x-forwarded-for') ?? 'unknown';
  if (throttled(ip.split(',')[0]!.trim())) {
    return fail(
      429,
      'TOO_MANY_REQUESTS',
      'We already have your request. We will be in touch soon.',
    );
  }

  const subject = `${TOPIC_LABEL[topic as Topic]}: ${clean(lead.clinic)}`;
  const text = [
    `${TOPIC_LABEL[topic as Topic]} from the DoctorDesk website`,
    '',
    `Name:   ${clean(lead.name)}`,
    `Clinic: ${clean(lead.clinic)}`,
    `Phone:  ${clean(lead.phone)}`,
    `Email:  ${clean(lead.email)}`,
    `City:   ${clean(lead.city)}`,
    `Notes:  ${lead.notes || '-'}`,
    '',
    `Received ${new Date().toISOString()}`,
  ].join('\n');

  const env = process.env;
  if ((env.MAIL_DRIVER ?? 'console') === 'console') {
    console.info(`[leads] MAIL_DRIVER=console, not sent.\nSubject: ${subject}\n${text}`);
    return Response.json({ status: 'received' }, { status: 202 });
  }

  const to = env.LEADS_EMAIL_TO;
  if (!to || !env.MAIL_HOST) {
    console.error('[leads] LEADS_EMAIL_TO or MAIL_HOST is not set; request not delivered.');
    return fail(
      503,
      'LEADS_NOT_CONFIGURED',
      'Requests cannot be sent right now. Please try again later.',
    );
  }

  try {
    transporter ??= createTransport({
      host: env.MAIL_HOST,
      port: Number(env.MAIL_PORT ?? 587),
      secure: /^(1|true|yes)$/i.test(env.MAIL_SECURE ?? ''),
      ...(env.MAIL_USER ? { auth: { user: env.MAIL_USER, pass: env.MAIL_PASSWORD ?? '' } } : {}),
    });
    await transporter.sendMail({
      from: env.MAIL_FROM ?? env.MAIL_USER ?? to,
      to,
      replyTo: lead.email,
      subject,
      text,
    });
  } catch (err) {
    console.error(`[leads] Sending failed: ${(err as Error).message}`);
    return fail(
      503,
      'LEAD_SEND_FAILED',
      'Your request could not be sent. Please try again in a few minutes.',
    );
  }

  return Response.json({ status: 'received' }, { status: 202 });
}
