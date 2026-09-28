import type { CentralDb } from './central-db.js';
import { paginate } from '../dialect.js';
import { insertReturningId } from '../dialect.js';
import { toDateOrNull } from './central-db.js';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface ProvisioningStepRecord {
  id: number;
  tenantId: string;
  runId: string;
  step: string;
  status: StepStatus;
  attempt: number;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
}

/** Tabla `tenancy_provisioning_steps`: historial de cada paso de cada ejecución. */
export class ProvisioningStepRepository {
  constructor(private readonly central: CentralDb) {}

  private get db() {
    return this.central.db;
  }

  async start(
    tenantId: string,
    runId: string,
    step: string,
    attempt: number,
    now: Date,
  ): Promise<number> {
    const values = {
      tenant_id: tenantId,
      run_id: runId,
      step,
      status: 'running',
      attempt,
      started_at: now,
      created_at: now,
    };
    return insertReturningId(this.central.kind, this.db.insertInto('provisioning_steps').values(values));
  }

  async finish(
    id: number,
    status: StepStatus,
    now: Date,
    durationMs: number,
    error?: string,
  ): Promise<void> {
    await this.db
      .updateTable('provisioning_steps')
      .set({ status, finished_at: now, duration_ms: Math.round(durationMs), error: error ?? null })
      .where('id', '=', id)
      .execute();
  }

  /** Pasos de la ejecución más reciente del tenant. */
  async lastRun(tenantId: string): Promise<ProvisioningStepRecord[]> {
    const last = await this.db
      .selectFrom('provisioning_steps')
      .select('run_id')
      .where('tenant_id', '=', tenantId)
      .orderBy('id', 'desc')
      .$call((q) => paginate(this.central.kind, q, 1))
      .executeTakeFirst();
    return last ? this.list(tenantId, last.run_id) : [];
  }

  async list(tenantId: string, runId?: string): Promise<ProvisioningStepRecord[]> {
    let query = this.db
      .selectFrom('provisioning_steps')
      .selectAll()
      .where('tenant_id', '=', tenantId);
    if (runId) query = query.where('run_id', '=', runId);
    const rows = await query.orderBy('id').execute();
    return rows.map((row) => ({
      id: Number(row.id),
      tenantId: row.tenant_id,
      runId: row.run_id,
      step: row.step,
      status: row.status as StepStatus,
      attempt: Number(row.attempt),
      error: row.error,
      startedAt: toDateOrNull(row.started_at),
      finishedAt: toDateOrNull(row.finished_at),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    }));
  }
}
