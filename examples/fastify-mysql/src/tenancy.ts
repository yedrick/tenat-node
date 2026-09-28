import { fileURLToPath } from 'node:url';
import { ConsoleLogger, createTenancy, type Logger } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { mysql } from '@tenancy-node/db-mysql';

export interface TenancyOptions {
  databaseUrl?: string;
  /** Con llave: cada tenant tiene su propio usuario de MySQL (contraseña cifrada). */
  encryptionKey?: string;
  logger?: Logger;
}

export function createAppTenancy(options: TenancyOptions = {}) {
  const encryptionKey = options.encryptionKey ?? process.env.TENANCY_KEY;
  return createTenancy({
    centralDomains: ['localhost'],
    logger: options.logger ?? new ConsoleLogger('info'),
    plugins: [
      database({
        driver: mysql(),
        central: {
          url: options.databaseUrl ?? process.env.DATABASE_URL ?? 'mysql://root:secret@127.0.0.1:3306/tenancy',
        },
        ...(encryptionKey ? { encryptionKey, credentials: 'per-tenant' as const } : {}),
        migrations: { tenant: fileURLToPath(new URL('../migrations/tenant', import.meta.url)) },
        seed: async (db, tenant) => {
          await db
            .insertInto('productos')
            .values({ nombre: `Camiseta ${tenant.name}`, precio: 100 })
            .execute();
        },
      }),
    ],
  });
}

export type AppTenancy = ReturnType<typeof createAppTenancy>;
