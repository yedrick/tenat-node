import {
  createTenancy,
  MemoryStorage,
  type Tenancy,
  type TenancyConfig,
  type Tenant,
} from '@tenancy-node/core';
import { FakeClock, MemoryLogger, SequentialIdGenerator } from './fakes.js';

export interface TestTenancy {
  tenancy: Tenancy;
  clock: FakeClock;
  logger: MemoryLogger;
  /** Crea tenants activos con dominio `{id}.test`. */
  seed(ids: readonly string[]): Promise<Tenant[]>;
}

/** Tenancy en memoria, con reloj falso y logger inspeccionable. */
export function createTestTenancy(overrides: TenancyConfig = {}): TestTenancy {
  const clock = new FakeClock();
  const logger = new MemoryLogger();
  const tenancy = createTenancy({
    centralDomains: ['app.test'],
    clock,
    logger,
    idGenerator: new SequentialIdGenerator(),
    storage: new MemoryStorage(),
    ...overrides,
  });
  return {
    tenancy,
    clock,
    logger,
    async seed(ids) {
      const tenants: Tenant[] = [];
      for (const id of ids)
        tenants.push(await tenancy.tenants.create({ id, domain: `${id}.test` }));
      return tenants;
    },
  };
}
