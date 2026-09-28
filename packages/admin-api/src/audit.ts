import { paginate, type CentralAccess } from '@tenancy-node/db';

export interface AuditEntry {
  id: number;
  adminUserId: number | null;
  /** Email del usuario del panel (si todavía existe). */
  adminEmail: string | null;
  action: string;
  tenantId: string | null;
  targetType: string | null;
  targetId: string | null;
  changes: unknown;
  ip: string | null;
  createdAt: Date;
}

export interface AuditInput {
  adminUserId: number | null;
  action: string;
  tenantId?: string | null;
  targetType?: string;
  targetId?: string | number;
  /** `{ before, after }` u otros datos del cambio (nunca secretos). */
  changes?: unknown;
  ip?: string | null;
}

/** Registro de auditoría del panel (`tenancy_audit_log`): sin FK, sobrevive al borrado del tenant. */
export class AuditLog {
  constructor(private readonly central: CentralAccess) {}

  async record(input: AuditInput): Promise<void> {
    await this.central.db
      .insertInto('audit_log')
      .values({
        admin_user_id: input.adminUserId,
        action: input.action,
        tenant_id: input.tenantId ?? null,
        target_type: input.targetType ?? null,
        target_id: input.targetId === undefined ? null : String(input.targetId),
        changes: input.changes === undefined ? null : JSON.stringify(input.changes),
        ip: input.ip ?? null,
        created_at: new Date(),
      })
      .execute();
  }

  async list(
    filters: {
      tenantId?: string;
      adminUserId?: number;
      action?: string;
      limit?: number;
      before?: number;
    } = {},
  ): Promise<AuditEntry[]> {
    let query = this.central.db
      .selectFrom('audit_log')
      .leftJoin('admin_users', 'admin_users.id', 'audit_log.admin_user_id')
      .selectAll('audit_log')
      .select('admin_users.email as admin_email');
    if (filters.tenantId) query = query.where('audit_log.tenant_id', '=', filters.tenantId);
    if (filters.adminUserId)
      query = query.where('audit_log.admin_user_id', '=', filters.adminUserId);
    if (filters.action) {
      query = query.where(
        'audit_log.action',
        'like',
        `${filters.action.replace(/[%_\\]/g, (c) => `\\${c}`)}%`,
      );
    }
    if (filters.before) query = query.where('audit_log.id', '<', filters.before);
    const rows = await query
      .orderBy('audit_log.id', 'desc')
      .$call((q) => paginate(this.central.kind, q, Math.min(filters.limit ?? 50, 200)))
      .execute();
    return rows.map((r) => ({
      id: Number(r.id),
      adminUserId: r.admin_user_id === null ? null : Number(r.admin_user_id),
      adminEmail: r.admin_email ?? null,
      action: r.action,
      tenantId: r.tenant_id,
      targetType: r.target_type,
      targetId: r.target_id,
      changes: typeof r.changes === 'string' ? JSON.parse(r.changes) : r.changes,
      ip: r.ip,
      createdAt: new Date(r.created_at),
    }));
  }
}
