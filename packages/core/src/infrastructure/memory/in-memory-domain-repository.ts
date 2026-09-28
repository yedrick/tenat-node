import {
  DomainAlreadyTakenError,
  type Domain,
  type DomainName,
  type TenantId,
} from '../../domain/index.js';
import type { DomainRepository, NewDomain } from '../../ports/index.js';

export class InMemoryDomainRepository implements DomainRepository {
  private readonly rows = new Map<string, Domain>();
  private nextId = 1;

  async findByName(domain: DomainName): Promise<Domain | undefined> {
    return this.rows.get(domain.value);
  }

  async listByTenant(tenantId: TenantId): Promise<Domain[]> {
    return [...this.rows.values()]
      .filter((d) => d.tenantId.equals(tenantId))
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.id - b.id);
  }

  async create(input: NewDomain): Promise<Domain> {
    if (this.rows.has(input.domain.value)) throw new DomainAlreadyTakenError(input.domain.value);
    const domain: Domain = {
      id: this.nextId++,
      domain: input.domain,
      tenantId: input.tenantId,
      isPrimary: false,
      verifiedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.rows.set(input.domain.value, domain);
    if (input.isPrimary) await this.setPrimary(input.tenantId, input.domain, input.now);
    return this.rows.get(input.domain.value)!;
  }

  async setPrimary(tenantId: TenantId, domain: DomainName, now: Date): Promise<void> {
    const target = this.rows.get(domain.value);
    if (!target || !target.tenantId.equals(tenantId)) return;
    for (const [key, row] of this.rows) {
      if (!row.tenantId.equals(tenantId)) continue;
      const isPrimary = key === domain.value;
      if (row.isPrimary !== isPrimary) this.rows.set(key, { ...row, isPrimary, updatedAt: now });
    }
  }

  async delete(domain: DomainName): Promise<void> {
    this.rows.delete(domain.value);
  }

  async deleteByTenant(tenantId: TenantId): Promise<void> {
    for (const [key, row] of this.rows) {
      if (row.tenantId.equals(tenantId)) this.rows.delete(key);
    }
  }
}
