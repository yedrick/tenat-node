import { createTenancy, type Logger } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { outbox } from '@tenancy-node/outbox';
import { rabbitmq } from '@tenancy-node/transport-rabbitmq';

export interface AppConfig {
  databaseUrl: string;
  rabbitUrl: string;
  logger?: Logger;
}

/**
 * La aplicación principal: crea tenants. Cada `tenant.created` queda en la outbox
 * (en la misma operación) y el relay lo publica en RabbitMQ.
 */
export function createApp(config: AppConfig) {
  const tenancy = createTenancy({
    centralDomains: ['tuapp.com'],
    ...(config.logger ? { logger: config.logger } : {}),
    events: { transports: [rabbitmq({ url: config.rabbitUrl })] },
    plugins: [database({ driver: postgres(), central: { url: config.databaseUrl } }), outbox()],
  });
  tenancy.events.forward('tenant.created', { transport: 'rabbitmq' });
  return tenancy;
}
