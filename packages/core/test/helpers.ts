import { InProcessEventBus, type Clock, type IdGenerator, type Logger } from '../src/index.js';

export {
  CachedDomainRepository,
  CachedTenantRepository,
  InMemoryDomainRepository,
  InMemoryTenantRepository,
  MemoryCacheStore,
} from '../src/index.js';

export function InMemoryEventBusFactory(deps: { clock: Clock; ids: IdGenerator; logger: Logger }) {
  return new InProcessEventBus({ ...deps, currentTenantId: () => null });
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
