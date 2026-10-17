import { insertReturningId, likeLower, paginate, type CentralAccess } from '@tenancy-node/db';

export const LEAD_STATUSES = ['new', 'contacted', 'converted', 'discarded'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Solicitud de la web comercial ("Solicitar demo"). */
export interface Lead {
  id: number;
  name: string;
  company: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  /** Plan de interés. */
  plan: string | null;
  message: string | null;
  /** Campos extra del formulario. */
  data: Record<string, string>;
  status: LeadStatus;
  /** Notas internas del equipo. */
  notes: string | null;
  /** Tenant creado a partir de la solicitud. */
  tenantId: string | null;
  ip: string | null;
  consentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewLead {
  name: string;
  company?: string | null;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
  plan?: string | null;
  message?: string | null;
  data?: Record<string, string>;
  ip?: string | null;
  /** `true` si aceptó el tratamiento de sus datos. */
  consent?: boolean;
}

export interface LeadChanges {
  status?: LeadStatus;
  notes?: string | null;
  tenantId?: string | null;
}

type Row = {
  id: number | string;
  name: string;
  company: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  plan: string | null;
  message: string | null;
  data: unknown;
  status: string;
  notes: string | null;
  tenant_id: string | null;
  ip: string | null;
  consent_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const toDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));

function fromRow(r: Row): Lead {
  const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  return {
    id: Number(r.id),
    name: r.name,
    company: r.company,
    city: r.city,
    phone: r.phone,
    email: r.email,
    plan: r.plan,
    message: r.message,
    data: (data as Record<string, string> | null) ?? {},
    status: r.status as LeadStatus,
    notes: r.notes,
    tenantId: r.tenant_id,
    ip: r.ip,
    consentAt: r.consent_at === null ? null : toDate(r.consent_at),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

/** Solicitudes de demo (`tenancy_leads`). Sin FK al tenant: sobreviven a su borrado. */
export class Leads {
  constructor(private readonly central: CentralAccess) {}

  async create(input: NewLead): Promise<Lead> {
    const now = new Date();
    const values = {
      name: input.name,
      company: input.company ?? null,
      city: input.city ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      plan: input.plan ?? null,
      message: input.message ?? null,
      data: input.data && Object.keys(input.data).length > 0 ? JSON.stringify(input.data) : null,
      status: 'new',
      notes: null,
      tenant_id: null,
      ip: input.ip ?? null,
      consent_at: input.consent ? now : null,
      created_at: now,
      updated_at: now,
    };
    const id = await insertReturningId(
      this.central.kind,
      this.central.db.insertInto('leads').values(values),
    );
    return (await this.find(Number(id)))!;
  }

  async find(id: number): Promise<Lead | undefined> {
    const row = await this.central.db
      .selectFrom('leads')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? fromRow(row as Row) : undefined;
  }

  async list(
    query: { status?: LeadStatus; search?: string; page?: number; perPage?: number } = {},
  ): Promise<{ items: Lead[]; total: number; page: number; perPage: number }> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const perPage = Math.min(100, Math.max(1, Math.floor(query.perPage ?? 20)));
    let base = this.central.db.selectFrom('leads');
    if (query.status) base = base.where('status', '=', query.status);
    if (query.search) {
      const pattern = `%${query.search.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      const kind = this.central.kind;
      base = base.where((eb) =>
        eb.or(
          (['name', 'company', 'email', 'city'] as const).map((c) => likeLower(kind, c, pattern)),
        ),
      );
    }
    const [count, rows] = await Promise.all([
      base.select((eb) => eb.fn.countAll<number | string>().as('total')).executeTakeFirstOrThrow(),
      base
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .$call((q) => paginate(this.central.kind, q, perPage, (page - 1) * perPage))
        .execute(),
    ]);
    return { items: rows.map((r) => fromRow(r as Row)), total: Number(count.total), page, perPage };
  }

  async update(id: number, changes: LeadChanges): Promise<Lead | undefined> {
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (changes.status !== undefined) set.status = changes.status;
    if (changes.notes !== undefined) set.notes = changes.notes;
    if (changes.tenantId !== undefined) set.tenant_id = changes.tenantId;
    await this.central.db.updateTable('leads').set(set).where('id', '=', id).execute();
    return this.find(id);
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.central.db
      .deleteFrom('leads')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async countByStatus(): Promise<Record<LeadStatus, number>> {
    const rows = await this.central.db
      .selectFrom('leads')
      .select(['status', (eb) => eb.fn.countAll<number | string>().as('n')])
      .groupBy('status')
      .execute();
    const counts = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<
      LeadStatus,
      number
    >;
    for (const r of rows) counts[r.status as LeadStatus] = Number(r.n);
    return counts;
  }
}
