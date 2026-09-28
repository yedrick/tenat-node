import { TenantNotIdentifiedError, type Bootstrapper, type Tenant } from '@tenancy-node/core';
import type { ConnectionManager } from './connections.js';
import { DatabaseNotAssignedError } from './errors.js';
import type { PoolLease } from './pool/connection-pool-registry.js';
import type { ServerRegistry } from './servers/server-registry.js';

export const DATABASE_RESOURCE = 'db';

/** Entrega la conexión del tenant del contexto; la libera al salir del contexto. */
export class DatabaseBootstrapper implements Bootstrapper<PoolLease> {
  readonly name = DATABASE_RESOURCE;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly servers: ServerRegistry,
  ) {}

  async prepare(tenant: Tenant | null): Promise<void> {
    if (tenant?.database) await this.servers.ensure(tenant.database.serverId);
  }

  bootstrap(tenant: Tenant | null): PoolLease {
    if (!tenant) {
      throw new TenantNotIdentifiedError(
        'tenancy.db() needs a tenant context; use tenancy.centralDb() for the central database',
      );
    }
    if (!tenant.database) throw new DatabaseNotAssignedError(tenant.id.value);
    return this.connections.acquireTenant(tenant);
  }

  revert(lease: PoolLease): void {
    lease.release();
  }
}
