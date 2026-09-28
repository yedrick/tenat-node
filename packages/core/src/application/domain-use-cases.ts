import {
  DomainAlreadyTakenError,
  DomainName,
  DomainNotFoundError,
  TenancyEvents,
  type Domain,
} from '../domain/index.js';
import type { Clock, DomainRepository, EventBus, TenantReader } from '../ports/index.js';
import { requireTenant, type TenantRef } from './shared.js';

export class AddDomainUseCase {
  constructor(
    private readonly tenants: TenantReader,
    private readonly domains: DomainRepository,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  /** Agrega un dominio. El primer dominio de un tenant siempre queda como principal. */
  async execute(
    ref: TenantRef,
    rawDomain: string,
    options: { primary?: boolean } = {},
  ): Promise<Domain> {
    const tenant = await requireTenant(this.tenants, ref);
    const name = DomainName.create(rawDomain);
    if (await this.domains.findByName(name)) throw new DomainAlreadyTakenError(name.value);

    const existing = await this.domains.listByTenant(tenant.id);
    const makePrimary = existing.length === 0 || options.primary === true;
    const now = this.clock.now();

    let domain = await this.domains.create({
      domain: name,
      tenantId: tenant.id,
      isPrimary: false,
      now,
    });
    await this.events.publish(TenancyEvents.domain('domain.created', domain));

    if (makePrimary) {
      await this.domains.setPrimary(tenant.id, name, now);
      domain = { ...domain, isPrimary: true, updatedAt: now };
      await this.events.publish(TenancyEvents.domain('domain.primary_changed', domain));
    }
    return domain;
  }
}

export class RemoveDomainUseCase {
  constructor(
    private readonly domains: DomainRepository,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  /** Quita un dominio. Si era el principal, el más antiguo que quede pasa a serlo. */
  async execute(rawDomain: string): Promise<void> {
    const name = DomainName.create(rawDomain);
    const domain = await this.domains.findByName(name);
    if (!domain) throw new DomainNotFoundError(name.value);

    await this.domains.delete(name);
    await this.events.publish(TenancyEvents.domain('domain.deleted', domain));

    if (domain.isPrimary) {
      const [next] = await this.domains.listByTenant(domain.tenantId);
      if (next) {
        const now = this.clock.now();
        await this.domains.setPrimary(domain.tenantId, next.domain, now);
        await this.events.publish(
          TenancyEvents.domain('domain.primary_changed', {
            ...next,
            isPrimary: true,
            updatedAt: now,
          }),
        );
      }
    }
  }
}

export class SetPrimaryDomainUseCase {
  constructor(
    private readonly domains: DomainRepository,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  async execute(rawDomain: string): Promise<Domain> {
    const name = DomainName.create(rawDomain);
    const domain = await this.domains.findByName(name);
    if (!domain) throw new DomainNotFoundError(name.value);
    if (domain.isPrimary) return domain;

    const now = this.clock.now();
    await this.domains.setPrimary(domain.tenantId, name, now);
    const updated = { ...domain, isPrimary: true, updatedAt: now };
    await this.events.publish(TenancyEvents.domain('domain.primary_changed', updated));
    return updated;
  }
}

export class ListDomainsUseCase {
  constructor(
    private readonly tenants: TenantReader,
    private readonly domains: DomainRepository,
  ) {}

  async execute(ref: TenantRef): Promise<Domain[]> {
    const tenant = await requireTenant(this.tenants, ref);
    return this.domains.listByTenant(tenant.id);
  }
}
