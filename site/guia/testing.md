# Testing

`@tenancy-node/testing` trae lo que el propio proyecto usa para probarse: una instancia en memoria lista para tests, fakes para el reloj, los ids y el logger, y suites de contrato para verificar tus adaptadores. Necesita `vitest` (peer dependency, versión 2 o superior).

```bash
pnpm add -D @tenancy-node/testing vitest
```

## `createTestTenancy()`

Crea una instancia en memoria con reloj falso, logger inspeccionable, ids predecibles y archivos en memoria. `seed(ids)` crea tenants activos con dominio `{id}.test`.

```ts
import { createTestTenancy } from '@tenancy-node/testing';
import { describe, expect, it } from 'vitest';

describe('carrito', () => {
  it('no mezcla los carritos de dos tenants', async () => {
    const { tenancy, seed } = createTestTenancy();
    await seed(['bolivar', 'tigre']); // activos, con dominio bolivar.test y tigre.test

    await tenancy.run('bolivar', () => tenancy.cache().set('carrito', { items: 2 }));
    expect(await tenancy.run('tigre', () => tenancy.cache().get('carrito'))).toBeUndefined();

    await tenancy.close();
  });
});
```

Devuelve `{ tenancy, clock, logger, seed }`. Lo que trae configurado:

| Opción          | Valor                           |
| --------------- | ------------------------------- |
| `centralDomains` | `['app.test']`                 |
| `clock`         | `FakeClock` (arranca en `2026-01-01T00:00:00.000Z`) |
| `logger`        | `MemoryLogger`                  |
| `idGenerator`   | `SequentialIdGenerator`         |
| `storage`       | `MemoryStorage`                 |

Tenants, dominios, caché y cola quedan en memoria (los valores por defecto de `createTenancy`). Puedes pasar cualquier opción de `createTenancy` para reemplazar algo: `createTestTenancy({ cache: redis(...) })`.

::: warning
Si reemplazas `clock` o `logger`, el `clock` y el `logger` que devuelve `createTestTenancy` siguen siendo los suyos, no los que pasaste: úsalos directamente.
:::

## Fakes

### `FakeClock`

Un `Clock` que solo avanza cuando tú quieres.

| Método          | Qué hace                                  |
| --------------- | ----------------------------------------- |
| `new FakeClock(start?)` | Fecha inicial (`Date` o texto ISO). Por defecto `2026-01-01T00:00:00.000Z` |
| `now()`         | La fecha actual del reloj                 |
| `advance(ms)`   | Avanza                                    |
| `set(date)`     | Salta a una fecha                         |

El reloj controla las fechas que guarda el paquete (creación de tenants, eventos, errores). No controla los `setTimeout` ni el TTL de la caché de búsqueda: para eso `lookupCache` acepta su propia función `now`.

### `SequentialIdGenerator`

Ids predecibles: `id-000001`, `id-000002`... Acepta un prefijo. Sirve para comparar ids de eventos y errores en los tests.

```ts
import { createTenancy } from '@tenancy-node/core';
import { FakeClock, MemoryLogger, SequentialIdGenerator } from '@tenancy-node/testing';

const tenancy = createTenancy({
  clock: new FakeClock('2026-03-01T12:00:00.000Z'),
  idGenerator: new SequentialIdGenerator('ev-'), // 'ev-000001', 'ev-000002'...
  logger: new MemoryLogger(),
});
```

### `MemoryLogger`

Guarda cada línea en `entries` como `{ level, message, fields }`. Los hijos (`child()`) escriben en la misma lista. Como todos los logs usan [campos fijos](/guia/observabilidad#logs-con-campos-fijos), puedes verificar qué se registró:

```ts
it('deja un error con código y tenant en el log', async () => {
  const { tenancy, logger, clock, seed } = createTestTenancy();
  await seed(['bolivar']);
  clock.advance(60_000); // el reloj solo avanza cuando tú quieres

  await expect(tenancy.tenants.create({ id: 'bolivar' })).rejects.toThrow();

  const [entry] = logger.find((e) => e.fields.operation === 'tenants.create' && e.level === 'warn');
  expect(entry?.fields).toMatchObject({
    tenantId: 'bolivar',
    outcome: 'error',
    code: 'TENANCY_TENANT_ALREADY_EXISTS',
  });
  expect(tenancy.observability.errors({ tenantId: 'bolivar' })[0]?.time).toEqual(clock.now());
});
```

`find(predicate)` filtra y `clear()` vacía la lista. Recuerda que las lecturas se registran en `debug` y los errores del cliente en `warn` ([niveles](/guia/observabilidad#niveles)).

### `MemoryTransport`

Un `EventTransport` que guarda los CloudEvents en `received`. Puede fallar a propósito: `failTimes` (cuántos envíos más fallan) y `down` (todos fallan mientras sea `true`). También cuenta `attempts` y marca `closed`. Sirve para probar `tenancy.events.forward` y los reintentos sin un broker real.

## Suites de contrato

Si escribes tu propio adaptador (un repositorio de tenants sobre otra base, una caché, un driver de cola), las suites de contrato verifican que cumpla lo mismo que los adaptadores oficiales. Son las mismas que corren contra memoria, MySQL, PostgreSQL, Redis, S3 y BullMQ.

| Suite                       | Puerto             | Qué verifica                                                                  |
| --------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| `tenantRepositoryContract`  | `TenantRepository` | Guardar y leer todos los campos, id duplicado (también en paralelo), borrado lógico, instancias independientes, filtros, búsqueda y páginas |
| `domainRepositoryContract`  | `DomainRepository` | Crear y buscar, dominio duplicado, un solo principal por tenant, borrar uno o todos los de un tenant |
| `cacheStoreContract`        | `CacheStore`       | Guardar, leer y borrar; llaves inexistentes; `flushTenant` solo borra las de ese tenant |
| `eventBusContract`          | `EventBus`         | Listeners `sync` antes de que `publish` termine, errores `sync` que se propagan, `async` sin bloquear, comodines y desuscripción |
| `storageDriverContract`     | `StorageDriver`    | Texto y binario, listar por prefijo sin mezclar tenants, borrar por prefijo, URLs |
| `queueDriverContract`       | `QueueDriver`      | Entrega con nombre, tenant y datos serializados; reintentos hasta el máximo    |

Cada función recibe un nombre y una fábrica, y registra un `describe` con todas las pruebas. La fábrica se llama antes de cada prueba y debe devolver un adaptador **vacío**:

```ts
import { cacheStoreContract, tenantRepositoryContract } from '@tenancy-node/testing';
import { MiCacheStore, MiTenantRepository } from '../src/adaptadores.js';

// Cada llamada registra un `describe` con todas las pruebas del contrato.
cacheStoreContract('MiCacheStore', () => new MiCacheStore());
tenantRepositoryContract('MiTenantRepository', async () => {
  const repo = new MiTenantRepository();
  // aquí vacías la tabla o la base: cada prueba empieza de cero
  return repo;
});
```

`domainRepositoryContract` usa los tenants `bolivar` y `tigre`: si tu base tiene una clave foránea hacia los tenants, créalos en la fábrica.

## Contra motores reales

Las pruebas unitarias corren en memoria. Las de integración del proyecto levantan los motores reales con [Testcontainers](https://testcontainers.com) (requiere Docker): MySQL 8, MariaDB 11, PostgreSQL 16, SQL Server 2022, Valkey 8, Memcached 1.6, SeaweedFS (S3), RabbitMQ 4, Kafka 3.9 y NATS 2. Cada suite se salta con `TENANCY_SKIP_DB_TESTS=1`.

El mismo patrón sirve para tu app:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTenancy } from '@tenancy-node/core';
import { database } from '@tenancy-node/db';
import { postgres } from '@tenancy-node/db-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(process.env.TENANCY_SKIP_DB_TESTS === '1')('con PostgreSQL real', () => {
  let container: StartedPostgreSqlContainer;
  let tenancy: ReturnType<typeof make>;
  const make = (url: string) =>
    createTenancy({ plugins: [database({ driver: postgres(), central: { url } })] });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    tenancy = make(container.getConnectionUri());
    await tenancy.database.install();
  }, 180_000);
  afterAll(async () => {
    await tenancy?.close();
    await container?.stop();
  });

  it('crea la base del tenant', async () => {
    const tenant = await tenancy.tenants.create({ id: 'bolivar' });
    expect(tenant.status).toBe('active');
  });
});
```

Levantar un contenedor tarda: usa un `beforeAll` con un timeout amplio y un contenedor por archivo, no por prueba.

En el repositorio:

```bash
pnpm test                          # build + todos los tests (con Docker)
TENANCY_SKIP_DB_TESTS=1 pnpm test  # sin Docker: solo lo que corre en memoria
pnpm coverage                      # con cobertura, incluidas las integraciones
```

El panel tiene además un E2E en Chromium real (Playwright usado como librería dentro de Vitest) contra PostgreSQL ([ADR 0011](/adr/0011-admin-ui)).

Referencia: [`@tenancy-node/testing`](/referencia/api/@tenancy-node/testing/).
