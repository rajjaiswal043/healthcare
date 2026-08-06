import { Injectable } from '@nestjs/common';
import type { TenantClient } from '@healthcloud/db';

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string;
  patientId?: string;
  changedFields?: string[];
  reason?: string;
  /** The authenticated user. Populated from the session, never from the client. */
  actorUserId?: string;
  actorLabel?: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

/**
 * Writes the audit trail (BRD FR-P36-19, NFR-07).
 *
 * Deliberately takes a transactional client rather than opening its own. The
 * audit row and the change it describes commit or roll back together — an audit
 * log that can disagree with the data it audits is worse than none, because it
 * is trusted.
 *
 * `changedFields` carries field NAMES ONLY, never values. An audit log
 * containing patient data is a second copy of the thing being protected, with a
 * longer retention period and usually weaker access controls.
 */
@Injectable()
export class AuditService {
  async record(tx: TenantClient, tenantId: string, entry: AuditEntry): Promise<void> {
    await tx.auditEvent.create({
      data: {
        tenantId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        patientId: entry.patientId ?? null,
        changedFields: entry.changedFields ?? [],
        reason: entry.reason ?? null,
        actorUserId: entry.actorUserId ?? null,
        actorLabel: entry.actorLabel ?? null,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
        correlationId: entry.correlationId ?? null,
      },
    });
  }
}
