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
  CollectAcrossBillsDto,
  CollectPaymentDto,
  DayCollectionQueryDto,
  FinanceReportQueryDto,
  InvoiceExceptionDto,
  CorrectPaymentModeDto,
  RefundDto,
  VoidWriteOffDto,
  WriteOffDto,
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

  /**
   * Every bill for a visit, not just the consultation's.
   *
   * The desk settles a patient, not an invoice: a visit with an X-ray on it has
   * two bills and the second one used to be on no screen the desk was looking
   * at. `appointments/:id/invoice` above still returns the consultation's alone
   * — the queue board links to it and wants exactly that one.
   */
  @Get('appointments/:id/invoices')
  @RequirePermissions(PERMISSIONS.INVOICE_READ)
  async allForAppointment(
    @CurrentTenant() tenantId: string,
    @Param('id', new ParseUUIDPipe()) appointmentId: string,
  ) {
    return this.billing.getAllForAppointment(tenantId, appointmentId);
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
   * One handover of money against several of this patient's bills.
   *
   * Patient-scoped rather than invoice-scoped because the thing being settled
   * is "what this person owes", not one document — and scoping it to the
   * patient is also what lets the server refuse a bill that belongs to
   * somebody else. Same permission as collecting once: it is the same act,
   * done fewer times. See `collectAcross`.
   */
  @Post('patients/:patientId/payments')
  @RequirePermissions(PERMISSIONS.PAYMENT_COLLECT)
  async collectAcross(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Body() dto: CollectAcrossBillsDto,
    @Req() req: FastifyRequest,
  ) {
    return this.billing.collectAcross(tenantId, patientId, dto, meta(req, user));
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

  /**
   * The money was right; the mode was wrong.
   *
   * Behind `payment:refund` like the other corrections, and for the same
   * reason: it writes a reversal, and the desk must not be able to unwind its
   * own entries. It takes nothing OUT on balance — the same amount goes
   * straight back in under the right mode — but the row it writes is a
   * reversal and belongs with its neighbours.
   */
  @Post('invoices/:id/payments/correct-mode')
  @RequirePermissions(PERMISSIONS.PAYMENT_REFUND)
  async correctPaymentMode(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CorrectPaymentModeDto,
    @Req() req: FastifyRequest,
  ) {
    return this.billing.correctPaymentMode(tenantId, id, { ...dto }, meta(req, user));
  }

  /**
   * Forgive part or all of a charge.
   *
   * REPLACES `invoices/:id/waive`, which could only write off a whole bill and
   * refused one that had been paid — so the desk had to refund first, which
   * flipped the bill back to UNPAID and left the patient apparently owing what
   * he had just been handed back. Narveer's call, 2 Nov 2026.
   *
   * Writing off the full balance still ends at `WAIVED`, so the board's
   * "Waived" column and every report that reads that status are unchanged.
   */
  @Post('invoices/:id/write-offs')
  @RequirePermissions(PERMISSIONS.INVOICE_WAIVE)
  async writeOff(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: WriteOffDto,
    @Req() req: FastifyRequest,
  ) {
    return this.billing.writeOff(tenantId, id, { ...dto }, meta(req, user));
  }

  /**
   * Undo one, because it went on the wrong bill.
   *
   * Behind the same permission as making one: whoever may forgive a charge may
   * take the forgiveness back, and the alternative was editing the database by
   * hand.
   */
  @Post('invoices/:id/write-offs/:writeOffId/void')
  @RequirePermissions(PERMISSIONS.INVOICE_WAIVE)
  async voidWriteOff(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('writeOffId', new ParseUUIDPipe()) writeOffId: string,
    @Body() dto: VoidWriteOffDto,
    @Req() req: FastifyRequest,
  ) {
    return this.billing.voidWriteOff(tenantId, id, writeOffId, dto.reason, meta(req, user));
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
