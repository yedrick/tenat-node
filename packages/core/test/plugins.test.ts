import { createTestTenancy, MemoryLogger } from '@tenancy-node/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryTenantRepository,
  InvalidConfigError,
  createTenancy,
  type TenancyPlugin,
  type Tenant,
} from '../src/index.js';

describe('plugins', () => {
  it('contribute repositories, provisioning, bootstrappers and methods', async () => {
    const tenants = new InMemoryTenantRepository();
    const provision = vi.fn(async (_t: Tenant) => {});
    const close = vi.fn(async () => {});
    const prepared: (string | null)[] = [];
    const plugin: TenancyPlugin<{ hello(): string; greeting(): string }> = {
      name: 'test',
      setup: (ctx) => {
        expect(ctx.centralDomains).toEqual(['app.com']);
        return {
          tenants,
          provisioning: { provision, deprovision: async () => {} },
          bootstrappers: [
            {
              name: 'greeting',
              bootstrap: (t) => `hola ${t?.id.value ?? 'central'}`,
              prepare: async (t) => void prepared.push(t?.id.value ?? null),
            },
          ],
          close,
        };
      },
      extend: (tenancy) => ({
        hello: () => `hello ${tenancy.currentId() ?? 'central'}`,
        greeting: () => tenancy.resource<string>('greeting'),
      }),
    };

    const tenancy = createTenancy({
      centralDomains: ['app.com'],
      logger: new MemoryLogger(),
      plugins: [plugin],
    });
    await tenancy.tenants.create({ id: 'bolivar' });
    expect(provision).toHaveBeenCalledOnce();
    expect(await tenants.exists((await tenancy.tenants.findOrFail('bolivar')).id)).toBe(true);
    expect(await tenancy.run('bolivar', () => [tenancy.hello(), tenancy.greeting()])).toEqual([
      'hello bolivar',
      'hola bolivar',
    ]);
    expect(prepared).toEqual(['bolivar']);
    await tenancy.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects conflicting plugins and redefinitions', () => {
    const repoPlugin = (name: string): TenancyPlugin => ({
      name,
      setup: () => ({ tenants: new InMemoryTenantRepository() }),
    });
    expect(() =>
      createTenancy({ logger: new MemoryLogger(), plugins: [repoPlugin('a'), repoPlugin('b')] }),
    ).toThrow(/Plugins "a" and "b" both provide "tenants"/);
    const bad: TenancyPlugin<{ run: () => void }> = {
      name: 'bad',
      setup: () => ({}),
      extend: () => ({ run: () => {} }),
    };
    expect(() => createTenancy({ logger: new MemoryLogger(), plugins: [bad] })).toThrow(
      InvalidConfigError,
    );
    const plain: TenancyPlugin = { name: 'plain', setup: () => ({}) };
    expect(() => createTestTenancy({ plugins: [plain] })).not.toThrow();
  });
});
