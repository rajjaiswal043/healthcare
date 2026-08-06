import { Catch, HttpException, HttpStatus, Logger, type ArgumentsHost } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

/**
 * One error shape for the whole API.
 *
 * The client gets a predictable envelope and — importantly for a system holding
 * patient data — never a stack trace, SQL fragment, or database message. Those
 * go to the log against a correlation id the client can quote.
 *
 * Replies through the HTTP adapter rather than by calling FastifyReply methods
 * directly. Exceptions thrown in MIDDLEWARE arrive here with a raw Node
 * ServerResponse, not a FastifyReply, so `reply.status(...)` is undefined and
 * the filter itself crashes — taking the process down instead of returning a
 * 401. The adapter handles both shapes.
 */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    correlationId: string;
    details?: unknown;
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<unknown>();
    const req = ctx.getRequest<{ id?: string }>();
    const correlationId = req?.id ?? 'unknown';

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();

      let message = exception.message;
      let details: unknown;

      if (typeof response === 'object' && response !== null) {
        const asRecord = response as Record<string, unknown>;

        if (typeof asRecord.message === 'string') {
          message = asRecord.message;
        } else if (Array.isArray(asRecord.message)) {
          // ValidationPipe returns an ARRAY of per-field messages. Flattening it
          // to "Bad Request Exception" throws away the only genuinely useful
          // part — which field was wrong and why — so keep both: a readable
          // summary, and the full list for the form to attach to inputs.
          const fieldErrors = asRecord.message.filter((m): m is string => typeof m === 'string');
          message = fieldErrors.join('; ');
          details = { fieldErrors };
        }

        // Structured payloads (e.g. duplicate candidates on a 409) pass through
        // so the UI can act on them rather than only display a string.
        const { message: _m, statusCode: _s, error: _e, ...rest } = asRecord;
        if (Object.keys(rest).length > 0) {
          details = { ...(typeof details === 'object' ? details : {}), ...rest };
        }
      } else if (typeof response === 'string') {
        message = response;
      }

      const body: ErrorResponse = {
        error: {
          code: HttpStatus[status] ?? 'ERROR',
          message,
          correlationId,
          ...(details !== undefined ? { details } : {}),
        },
      };

      // 4xx is the caller's problem and safe to describe. 5xx is ours.
      if (status >= 500) {
        this.logger.error({ err: exception, correlationId }, 'Request failed');
      }

      httpAdapter.reply(res, body, status);
      return;
    }

    // Anything unrecognised is a bug: log everything, tell the client nothing.
    this.logger.error({ err: exception, correlationId }, 'Unhandled exception');

    httpAdapter.reply(
      res,
      {
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Something went wrong. Quote the correlation id if you report this.',
          correlationId,
        },
      } satisfies ErrorResponse,
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
