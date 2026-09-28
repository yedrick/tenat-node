import {
  DomainAlreadyTakenError,
  DomainName,
  Tenant,
  TenantAlreadyExistsError,
  TenancyEvents,
  TenantId,
  TenantProvisioningError,
  Theme,
  type TenantChanges,
  type TenantData,
  type ThemePatch,
  type ThemeProps,
} from '../domain/index.js';
import type {
  Clock,
  DomainRepository,
  EventBus,
  Page,
  ProvisioningPipeline,
  TenantListQuery,
  TenantReader,
  TenantRepository,
} from '../ports/index.js';
import { requireTenant, type TenantRef } from './shared.js';

export interface CreateTenantInput {
  id: string;
  /** Por defecto, el mismo id. */
  name?: string;
  plan?: string | null;
  data?: TenantData;
  /** Se combina con el tema por defecto de la configuración. */
  theme?: ThemePatch;
  /** Dominio(s) del tenant. El primero queda como principal. */
  domain?: string | readonly string[];
}

/** Registra un tenant, sus dominios y lo aprovisiona. */
export class CreateTenantUseCase {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly domains: DomainRepository,
    private readonly provisioning: ProvisioningPipeline,
    private readonly events: EventBus,
    private readonly clock: Clock,
    private readonly themeDefaults: ThemeProps,
  ) {}

  async execute(input: CreateTenantInput): Promise<Tenant> {
    const id = TenantId.create(input.id);
    const domainNames = normalizeDomainList(input.domain);

    if (await this.tenants.exists(id)) throw new TenantAlreadyExistsError(id.value);
    for (const name of domainNames) {
      if (await this.domains.findByName(name)) throw new DomainAlreadyTakenError(name.value);
    }

    const now = this.clock.now();
    const tenant = Tenant.create({
      id,
      name: input.name ?? id.value,
      plan: input.plan ?? null,
      data: input.data ?? {},
      theme: input.theme ? Theme.create(this.themeDefaults).merge(input.theme) : null,
      now,
    });

    // Los listeners `sync` de tenant.creating pueden cancelar la creación lanzando un error.
    await this.events.publish(TenancyEvents.tenant('tenant.creating', tenant));

    await this.tenants.insert(tenant);
    for (const [index, domain] of domainNames.entries()) {
      const created = await this.domains.create({
        domain,
        tenantId: id,
        isPrimary: index === 0,
        now,
      });
      await this.events.publish(TenancyEvents.domain('domain.created', created));
    }
    await this.events.publish(TenancyEvents.tenant('tenant.created', tenant));

    await runProvisioning(tenant, this.tenants, this.provisioning, this.events, this.clock);
    return tenant;
  }
}

/** Vuelve a correr el aprovisionamiento de un tenant en estado `failed`. */
export class RetryProvisioningUseCase {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly provisioning: ProvisioningPipeline,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  async execute(ref: TenantRef): Promise<Tenant> {
    const tenant = await requireTenant(this.tenants, ref);
    tenant.markProvisioning(this.clock.now());
    await this.tenants.save(tenant);
    await runProvisioning(tenant, this.tenants, this.provisioning, this.events, this.clock);
    return tenant;
  }
}

async function runProvisioning(
  tenant: Tenant,
  tenants: TenantRepository,
  provisioning: ProvisioningPipeline,
  events: EventBus,
  clock: Clock,
): Promise<void> {
  try {
    await provisioning.provision(tenant);
  } catch (error) {
    tenant.markFailed(clock.now());
    await tenants.save(tenant);
    await events.publish(TenancyEvents.provisioningFailed(tenant, error));
    throw new TenantProvisioningError(tenant.id.value, error);
  }
  tenant.markProvisioned(clock.now());
  await tenants.save(tenant);
  await events.publish(TenancyEvents.tenant('tenant.provisioned', tenant));
}

function normalizeDomainList(input: string | readonly string[] | undefined): DomainName[] {
  if (input === undefined) return [];
  const list = typeof input === 'string' ? [input] : input;
  const unique = new Map<string, DomainName>();
  for (const raw of list) {
    const name = DomainName.create(raw);
    unique.set(name.value, name);
  }
  return [...unique.values()];
}

export class FindTenantUseCase {
  constructor(private readonly tenants: TenantReader) {}

  /** Devuelve el tenant o `undefined`. */
  async execute(ref: TenantRef): Promise<Tenant | undefined> {
    const id = typeof ref === 'string' ? TenantId.tryCreate(ref) : ref;
    return id ? this.tenants.findById(id) : undefined;
  }
}

export class ListTenantsUseCase {
  constructor(private readonly tenants: TenantReader) {}

  execute(query: TenantListQuery = {}): Promise<Page<Tenant>> {
    return this.tenants.list(query);
  }
}

export class UpdateTenantUseCase {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  async execute(ref: TenantRef, changes: TenantChanges): Promise<Tenant> {
    const tenant = await requireTenant(this.tenants, ref);
    const changed = tenant.update(changes, this.clock.now());
    if (changed.length > 0) {
      await this.tenants.save(tenant);
      await this.events.publish(TenancyEvents.tenantUpdated(tenant, changed));
    }
    return tenant;
  }
}

export class SuspendTenantUseCase {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  async execute(ref: TenantRef): Promise<Tenant> {
    const tenant = await requireTenant(this.tenants, ref);
    tenant.suspend(this.clock.now());
    await this.tenants.save(tenant);
    await this.events.publish(TenancyEvents.tenant('tenant.suspended', tenant));
    return tenant;
  }
}

export class ActivateTenantUseCase {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  async execute(ref: TenantRef): Promise<Tenant> {
    const tenant = await requireTenant(this.tenants, ref);
    tenant.activate(this.clock.now());
    await this.tenants.save(tenant);
    await this.events.publish(TenancyEvents.tenant('tenant.activated', tenant));
    return tenant;
  }
}

export class PutTenantInMaintenanceUseCase {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  async execute(ref: TenantRef, message: string | null = null): Promise<Tenant> {
    const tenant = await requireTenant(this.tenants, ref);
    tenant.putInMaintenance(message, this.clock.now());
    await this.tenants.save(tenant);
    await this.events.publish(TenancyEvents.tenantMaintenance(tenant));
    return tenant;
  }
}

/** Borrado suave: libera los recursos físicos y los dominios, y marca `deletedAt`. */
export class DeleteTenantUseCase {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly domains: DomainRepository,
    private readonly provisioning: ProvisioningPipeline,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  async execute(ref: TenantRef): Promise<void> {
    const tenant = await requireTenant(this.tenants, ref);
    tenant.markDeleting(this.clock.now());
    await this.tenants.save(tenant);

    await this.provisioning.deprovision(tenant);
    await this.domains.deleteByTenant(tenant.id);

    tenant.markDeleted(this.clock.now());
    await this.tenants.save(tenant);
    await this.events.publish(TenancyEvents.tenant('tenant.deleted', tenant));
  }
}
