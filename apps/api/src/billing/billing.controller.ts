import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  CurrentTenant,
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../platform/auth/decorators.js';
import { PERMISSIONS } from '../platform/auth/permissions.js';
import { PrismaService } from '../platform/database/prisma.service.js';
import { BillingService, type RequestMeta } from './billing.service.js';
import { FinanceReportService } from './finance-report.service.js';
import { ReceiptsService } from './receipts.service.js';
import {
  AddLineDto,
  CollectPaymentDto,
  DayCollectionQueryDto,
  FinanceReportQueryDto,
  InvoiceExceptionDto,
  RefundDto,
} from './dto.js';

@Controller()
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly financeReport: FinanceReportService,
    private readonly receipts: ReceiptsService,
    private readonly prisma: PrismaService,
  ) {}

  /** The chargeable catalogue, for adding items to a bill. */
  @Get('services')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  async services(@CurrentTenant() tenantId: string) {
    const services = await this.prisma.forTenant(tenantId, (tx) =>
      tx.service.findMany({
        where: { isActive: true },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          category: true,
          pricePaise: true,
          taxRateBasisPoints: true,
        },
      }),
    );
    return { services };
  }

  @Get('invoices/:id')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  async get(@CurrentTenant() tenantId: string, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.billing.get(tenantId, id);
  }

  /** The bill for a visit — what the queue board links to. */
  @Get('appointments/:id/invoice')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  async forAppointment(
    @CurrentTenant() tenantId: string,
    @Param('id', new ParseUUIDPipe()) appointmentId: string,
  ) {
    return this.billing.getForAppointment(tenantId, appointmentId);
  }

  @Post('invoices/:id/lines')
  @RequirePermissions(PERMISSIONS.INVOICE_WRITE)
  async addLine(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AddLineDto,
    @Req() req: FastifyRequest,
  ) {
    return this.billing.addLine(tenantId, id, dto, meta(req, user));
  }

  @Delete('invoices/:id/lines/:lineId')
  @RequirePermissions(PERMISSIONS.INVOICE_WRITE)
  async removeLine(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('lineId', new ParseUUIDPipe()) lineId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.billing.removeLine(tenantId, id, lineId, meta(req, user));
  }

  @Post('invoices/:id/payments')
  @RequirePermissions(PERMISSIONS.PAYMENT_COLLECT)
  async collect(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CollectPaymentDto,
    @Req() req: FastifyRequest,
  ) {
    return this.billing.collect(tenantId, id, dto, meta(req, user));
  }

  /**
   * Refunds, waivers and deferrals each sit behind their own permission.
   *
   * Every one of them is a way for money to leave without a service behind it,
   * so the person at the desk cannot authorise their own exception.
   */
  @Post('invoices/:id/refunds')
  @RequirePermissions(PERMISSIONS.PAYMENT_REFUND)
  async refund(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RefundDto,
    @Req() req: FastifyRequest,
  ) {
    return this.billing.refund(tenantId, id, dto, meta(req, user));
  }

  @Post('invoices/:id/waive')
  @RequirePermissions(PERMISSIONS.INVOICE_WAIVE)
  async waive(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: InvoiceExceptionDto,
    @Req() req: FastifyRequest,
  ) {
    return this.billing.setException(tenantId, id, 'WAIVED', dto.reason, meta(req, user));
  }

  @Post('invoices/:id/defer')
  @RequirePermissions(PERMISSIONS.INVOICE_DEFER)
  async defer(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: InvoiceExceptionDto,
    @Req() req: FastifyRequest,
  ) {
    return this.billing.setException(tenantId, id, 'DEFERRED', dto.reason, meta(req, user));
  }

  @Post('invoices/:id/cancel')
  @RequirePermissions(PERMISSIONS.INVOICE_WAIVE)
  async cancel(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: InvoiceExceptionDto,
    @Req() req: FastifyRequest,
  ) {
    return this.billing.setException(tenantId, id, 'CANCELLED', dto.reason, meta(req, user));
  }

  /**
   * The finance desk's report (FR-FIN-03, as amended by FR-DIA-15).
   *
   * Collections, billing per doctor AND per department, where the diagnostic
   * work came from, discounts given, what is still owed, and money that went
   * back — over a range, defaulting to today.
   *
   * The department split exists because a walk-in test patient never meets a
   * doctor, so a by-doctor report cannot see them: their money would sit in a
   * nameless bucket while the department that earned it looked idle.
   *
   * Behind `report:revenue`, the same permission as the day's collections, and
   * for the same reason: this is the screen that says what the clinic earned,
   * and it should not be open on a monitor a waiting room can see. The finance
   * role holds it; the front desk does not.
   */
  @Get('reports/finance')
  @RequirePermissions(PERMISSIONS.REPORT_REVENUE)
  async finance(@CurrentTenant() tenantId: string, @Query() query: FinanceReportQueryDto) {
    return this.financeReport.report(tenantId, query);
  }

  /**
   * The printable receipt for one payment (FR-RCP-01, -02).
   *
   * Behind `invoice:read`, the same permission as seeing the bill it came from.
   * Printing paper for money already taken is not a privileged act — the finance
   * desk, the front desk and the administrator all hold it, and a doctor holds
   * neither this nor the invoice.
   *
   * A GET, so it still answers for a SUSPENDED clinic. That guard's own message
   * promises "you can still open, print and export everything already here", and
   * a receipt that stopped printing the day a clinic was suspended would make
   * that sentence untrue.
   */
  @Get('payments/:id/receipt')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  async receipt(@CurrentTenant() tenantId: string, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.receipts.forPayment(tenantId, id);
  }

  /** Who has printed this receipt, and when. The answer to "how does a second copy exist". */
  @Get('payments/:id/receipt/prints')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  async receiptPrints(
    @CurrentTenant() tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.receipts.prints(tenantId, id);
  }

  /**
   * Record that the receipt went on paper, and say which print it was.
   *
   * Returns the payload too, so the screen cannot render a sheet it forgot to
   * log. The first print is the receipt; every one after it comes back with
   * `isDuplicate` and the sheet says so on its face.
   */
  @Post('payments/:id/receipt/prints')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  async recordReceiptPrint(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: FastifyRequest,
  ) {
    return this.receipts.recordPrint(tenantId, id, meta(req, user));
  }

  /** What the clinic took today, by mode and by collector (FR-BIL-09). */
  @Get('reports/day-collection')
  @RequirePermissions(PERMISSIONS.REPORT_REVENUE)
  async dayCollection(@CurrentTenant() tenantId: string, @Query() query: DayCollectionQueryDto) {
    return this.billing.dayCollection(tenantId, query.date);
  }

  /** Everything still owed, for the front desk to chase (FR-BIL-10). */
  @Get('invoices')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  async outstanding(@CurrentTenant() tenantId: string) {
    return this.billing.outstanding(tenantId);
  }
}

function meta(req: FastifyRequest, user: AuthenticatedUser): RequestMeta {
  const out: RequestMeta = { correlationId: req.id, actorUserId: user.userId };
  if (req.ip) out.ipAddress = req.ip;
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') out.userAgent = ua.slice(0, 500);
  return out;
}
