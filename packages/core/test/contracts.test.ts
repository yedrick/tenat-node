import {
  cacheStoreContract,
  domainRepositoryContract,
  eventBusContract,
  FakeClock,
  MemoryLogger,
  SequentialIdGenerator,
  tenantRepositoryContract,
} from '@tenancy-node/testing';
import {
  CachedDomainRepository,
  CachedTenantRepository,
  InMemoryDomainRepository,
  InMemoryEventBusFactory,
  InMemoryTenantRepository,
  MemoryCacheStore,
} from './helpers.js';

tenantRepositoryContract('InMemoryTenantRepository', () => new InMemoryTenantRepository());
tenantRepositoryContract(
  'CachedTenantRepository',
  () => new CachedTenantRepository(new InMemoryTenantRepository()),
);
domainRepositoryContract('InMemoryDomainRepository', () => new InMemoryDomainRepository());
domainRepositoryContract(
  'CachedDomainRepository',
  () => new CachedDomainRepository(new InMemoryDomainRepository()),
);
cacheStoreContract('MemoryCacheStore', () => new MemoryCacheStore());
eventBusContract('InProcessEventBus', () =>
  InMemoryEventBusFactory({
    clock: new FakeClock(),
    ids: new SequentialIdGenerator(),
    logger: new MemoryLogger(),
  }),
);
