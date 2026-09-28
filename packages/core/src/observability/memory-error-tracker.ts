import type { ErrorSummary, ErrorTracker, TrackedError } from '../ports/index.js';

export interface MemoryErrorTrackerOptions {
  /** Errores guardados por tenant (ring buffer). Por defecto 100. */
  perTenant?: number;
  /** Tenants distintos que se siguen; se descarta el que lleva más tiempo sin errores. Por defecto 10 000. */
  maxTenants?: number;
}

interface Bucket {
  errors: TrackedError[];
  total: number;
  byCode: Record<string, number>;
  lastErrorAt: Date | null;
}

const CENTRAL_KEY = '\0central';

/** Registro de errores en memoria del proceso, separado por tenant. */
export class MemoryErrorTracker implements ErrorTracker {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perTenant: number;
  private readonly maxTenants: number;

  constructor(options: MemoryErrorTrackerOptions = {}) {
    this.perTenant = options.perTenant ?? 100;
    this.maxTenants = options.maxTenants ?? 10_000;
  }

  record(error: TrackedError): void {
    const key = keyOf(error.tenantId);
    const bucket = this.buckets.get(key) ?? { errors: [], total: 0, byCode: {}, lastErrorAt: null };
    this.buckets.delete(key);
    this.buckets.set(key, bucket);

    bucket.errors.push(error);
    if (bucket.errors.length > this.perTenant) bucket.errors.shift();
    bucket.total++;
    bucket.byCode[error.code] = (bucket.byCode[error.code] ?? 0) + 1;
    bucket.lastErrorAt = error.time;

    while (this.buckets.size > this.maxTenants) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
  }

  recent(options: { tenantId?: string | null; limit?: number } = {}): TrackedError[] {
    const limit = options.limit ?? 50;
    const source =
      options.tenantId === undefined
        ? [...this.buckets.values()].flatMap((b) => b.errors)
        : (this.buckets.get(keyOf(options.tenantId))?.errors ?? []);
    return [...source]
      .sort((a, b) => b.time.getTime() - a.time.getTime() || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }

  summary(): ErrorSummary[] {
    return [...this.buckets.entries()]
      .map(([key, bucket]) => ({
        tenantId: key === CENTRAL_KEY ? null : key,
        total: bucket.total,
        byCode: { ...bucket.byCode },
        lastErrorAt: bucket.lastErrorAt,
      }))
      .sort((a, b) => b.total - a.total);
  }

  clear(tenantId?: string | null): void {
    if (tenantId === undefined) this.buckets.clear();
    else this.buckets.delete(keyOf(tenantId));
  }
}

function keyOf(tenantId: string | null): string {
  return tenantId ?? CENTRAL_KEY;
}
