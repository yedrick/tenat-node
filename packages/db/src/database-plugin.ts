import {
  TenancyEvents,
  TenantNotFoundError,
  requireTenant,
  type Tenancy,
  type TenancyPlugin,
  type Tenant,
  type TenantStatus,
  type RunForEachResult,
} from '@tenancy-node/core';
import { sql, type Kysely } from 'kysely';
import { parseConnectionUrl, type ConnectionOptions, type Credentials } from './connection.js';
import { ConnectionManager, type CredentialsMode } from './connections.js';
import { Encrypter } from './crypto/encrypter.js';
import { DATABASE_RESOURCE, DatabaseBootstrapper } from './database-bootstrapper.js';
import type { DatabaseDriver, OpenedConnection, DialectKind } from './drivers/driver.js';
import { InvalidDatabaseConfigError } from './errors.js';
import type { AnyDB, AnyKysely } from './kysely-any.js';
import {
  toMigrator,
  type MigrationContext,
  type MigrationRun,
  type MigrationStatus,
  type MigrationsInput,
  type TenancyMigrator,
} from './migrations/migrator.js';
import {
  ConnectionPoolRegistry,
  type PoolLease,
  type PoolStats,
} from './pool/connection-pool-registry.js';
import {
  DatabaseProvisioning,
  type MoveOptions,
  type MoveResult,
  type PipelineStep,
} from './provisioning/database-provisioning.js';
import type { PlacementStrategy } from './provisioning/placement.js';
import { schemaTables } from './schema/schema-tables.js';
import { KyselyDomainRepository } from './repositories/kysely-domain-repository.js';
import { KyselyTenantRepository } from './repositories/kysely-tenant-repository.js';
import {
  ProvisioningStepRepository,
  type ProvisioningStepRecord,
} from './repositories/provisioning-step-repository.js';
import { DatabaseServerRepository, type DatabaseServer } from './repositories/server-repository.js';
import type { CentralDb } from './repositories/central-db.js';
import { centralMigrations } from './schema/central-migrations.js';
import { generateSchema, introspectTables, type SchemaFormat } from './schema/generate.js';
import type { CentralTables } from './schema/central-tables.js';
import { TablePrefixPlugin } from './schema/table-prefix-plugin.js';
import { ServerRegistry, type AddServerInput } from './servers/server-registry.js';
import { KyselyMigrator, migrationsFromObject } from './migrations/migrator.js';

export interface DatabasePluginOptions {
  /** Motor: `mysql()` de `@tenancy-node/db-mysql` o `postgres()` de `@tenancy-node/db-postgres`. */
  driver: DatabaseDriver;
  /** Base central: URL (`mysql://user:pass@host:3306/miapp`) u opciones sueltas. */
  central: ({ url: string } | ConnectionOptions) & { pool?: { max?: number } };
  /** Prefijo de las tablas del paquete. Por defecto `tenancy_`. */
  tablePrefix?: string;
  /** Llave AES-256-GCM (`TENANCY_KEY`). Obligatoria con `credentials: 'per-tenant'`. */
  encryptionKey?: string | undefined;
  /** Llaves anteriores, para leer valores cifrados antes de una rotación. */
  previousKeys?: readonly string[];
  /** `tenant_` + id + `suffix` = nombre de la base del tenant. */
  prefix?: string;
  suffix?: string;
  /**
   * `database` (por defecto): una base por tenant. `schema`: un schema por tenant dentro de una base
   * compartida (PostgreSQL), para hostings que no permiten `CREATE DATABASE`.
   */
  isolation?: 'database' | 'schema';
  /** Modo schema: base donde se crean los schemas. Por defecto, la base central. */
  schemaDatabase?: string;
  /** `shared` (por defecto): un usuario para todos. `per-tenant`: usuario y contraseña propios. */
  credentials?: CredentialsMode;
  /** Usuario compartido de los tenants. Por defecto, el administrador. */
  tenantCredentials?: Credentials;
  /** Usuario con permiso de `CREATE DATABASE`. Por defecto, el de la base central. */
  admin?: Credentials;
  /** Dónde crear cada tenant nuevo. Por defecto `least-tenants`. */
  placement?: PlacementStrategy;
  pool?: { max?: number; maxOpenPools?: number; idleTimeoutMs?: number };
  /** Borrar la base creada si falla el aprovisionamiento. Por defecto `false`. */
  cleanupOnFailure?: boolean;
  migrations?: {
    /** Migraciones de cada tenant: carpeta (`.sql` o módulos), objeto o un `TenancyMigrator`. */
    tenant?: MigrationsInput;
    /** Tus migraciones de la base central (tabla `tenancy_central_migrations`). */
    central?: MigrationsInput;
  };
  /** Datos iniciales de cada tenant. */
  seed?: ((db: AnyKysely, tenant: Tenant) => Promise<void>) | undefined;
  /** Pasos del aprovisionamiento. Por defecto `['createDatabase', 'createUser', 'migrate', 'seed']`. */
  pipeline?: readonly PipelineStep[];
  /** Espera máxima del candado por tenant. Por defecto 10 000 ms. */
  lockTimeoutMs?: number;
  /** Id del servidor de la base central. Por defecto `default`. */
  defaultServerId?: string;
  ssl?: unknown;
}

export interface TenantRunReport {
  tenantId: string;
  ok: boolean;
  durationMs: number;
  error?: unknown;
}

export interface MigrateOptions {
  /** Solo estos tenants. Por defecto, todos los activos, en mantenimiento o suspendidos. */
  tenants?: readonly string[] | undefined;
  concurrency?: number | undefined;
  /** Se llama al terminar cada tenant (para mostrar progreso). */
  onTenant?: ((report: TenantRunReport) => void) | undefined;
}

export interface DatabaseAdmin {
  /** Crea (o actualiza) las tablas `tenancy_*` y registra el servidor por defecto. Idempotente. */
  install(): Promise<MigrationRun>;
  /** Tus migraciones centrales. */
  migrateCentral(): Promise<MigrationRun>;
  migrate(options?: MigrateOptions): Promise<RunForEachResult>;
  rollback(options?: MigrateOptions & { steps?: number }): Promise<RunForEachResult>;
  seed(options?: MigrateOptions): Promise<RunForEachResult>;
  status(tenant: string): Promise<MigrationStatus[]>;
  servers: {
    add(input: AddServerInput): Promise<DatabaseServer>;
    list(): Promise<DatabaseServer[]>;
  };
  /**
   * Tablas de la base del tenant actual (sin las de control de migraciones). En modo schema,
   * solo las del schema del tenant: nunca las de otros tenants.
   */
  tables(): Promise<{ name: string; schema: string | undefined; columns: { name: string; dataType: string; isNullable: boolean }[] }[]>;
  /** Base central para plugins (outbox, webhooks, admin). */
  central(): CentralAccess;
  /** Conexión del tenant del contexto actual (síncrono). */
  connection(): TenantConnectionInfo;
  /** URL de conexión a la base del tenant (con sus credenciales), para herramientas externas. */
  connectionUrl(tenant: string): Promise<string>;
  /** Historial de aprovisionamiento del tenant. */
  provisioningSteps(tenant: string): Promise<ProvisioningStepRecord[]>;
  /** Modelos de las tablas `tenancy_*` para tu ORM (lee la estructura real de la base central). */
  schema(format: SchemaFormat): Promise<string>;
  /** Métricas de los pools abiertos. */
  pools(): PoolStats;
  /** Vuelve a cifrar con la llave actual todos los secretos guardados. */
  rotateKey(): Promise<{ updated: number }>;
  /**
   * Mueve la base del tenant a otro servidor (con el tenant en mantenimiento mientras tanto).
   * El origen se conserva salvo `dropSource: true`. Solo MySQL/MariaDB y PostgreSQL.
   */
  move(tenant: string, options: MoveOptions): Promise<MoveResult>;
}

/** Acceso a la base central para plugins (outbox, webhooks, panel admin). */
export interface CentralAccess {
  /** Tablas del paquete con nombres cortos (el prefijo se agrega solo). */
  db: Kysely<CentralTables>;
  /** Base central sin prefijo. */
  raw: AnyKysely;
  kind: DialectKind;
  tablePrefix: string;
  encrypter: Encrypter;
  driver: DatabaseDriver;
}

/** Conexión del tenant actual, para integraciones (ORMs) y herramientas externas. */
export interface TenantConnectionInfo {
  /** Identifica la conexión (servidor/base/usuario): sirve como llave de caché. */
  key: string;
  kind: DialectKind;
  options: ConnectionOptions;
  url: string;
  /**
   * Pool nativo (mysql2 / pg) ya abierto para el tenant. En modo schema con credenciales compartidas
   * es un pool compartido **sin** `search_path` del tenant: usa `db()` o `schema` para consultar.
   */
  native: unknown;
  /** Modo schema: schema del tenant. */
  schema: string | null;
  tenant: Tenant;
}

export interface DatabaseExtension {
  /** Base del tenant actual. */
  db<DB = AnyDB>(): Kysely<DB>;
  /** Base central, desde cualquier contexto. */
  centralDb<DB = AnyDB>(): Kysely<DB>;
  /** SQL puro parametrizado sobre la base del tenant actual: los valores nunca se concatenan. */
  sql<Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Row[]>;
  /**
   * Pool nativo de la base del tenant actual: mysql2 o pg; en SQLite, la `Database` de
   * better-sqlite3; en SQL Server, el dialecto de Kysely (Tedious + tarn).
   */
  pool<P = unknown>(): P;
  database: DatabaseAdmin;
}

const DEFAULT_PIPELINE: readonly PipelineStep[] = [
  'createDatabase',
  'createUser',
  'migrate',
  'seed',
];

/**
 * Plugin de base de datos: tablas centrales, repositorios SQL, pools por tenant,
 * aprovisionamiento y migraciones.
 *
 * ```ts
 * const tenancy = createTenancy({
 *   plugins: [database({ driver: mysql(), central: { url: process.env.DATABASE_URL! } })],
 * });
 * await tenancy.database.install();
 * ```
 */
export function database(options: DatabasePluginOptions): TenancyPlugin<DatabaseExtension> {
  const driver = options.driver;
  const tablePrefix = options.tablePrefix ?? 'tenancy_';
  if (!/^[a-z0-9_]*$/.test(tablePrefix))
    throw new InvalidDatabaseConfigError('tablePrefix must use a-z, 0-9 and "_"');
  const credentials = options.credentials ?? 'shared';
  const isolation = options.isolation ?? 'database';
  if (isolation === 'schema' && !driver.supportsSchemas) {
    throw new InvalidDatabaseConfigError(`isolation: "schema" is not supported by the ${driver.name} driver (use a database per tenant)`);
  }
  const encrypter = new Encrypter(options.encryptionKey, options.previousKeys ?? []);
  if (credentials === 'per-tenant' && driver.maxUserLength === 0) {
    throw new InvalidDatabaseConfigError(`credentials: "per-tenant" is not supported by the ${driver.name} driver`);
  }
  if (credentials === 'per-tenant' && !encrypter.hasKey) {
    throw new InvalidDatabaseConfigError('credentials: "per-tenant" requires an encryptionKey');
  }

  const centralOptions: ConnectionOptions =
    'url' in options.central
      ? parseConnectionUrl(options.central.url, driver.defaultPort)
      : options.central;
    const admin: Credentials = options.admin ?? { user: centralOptions.user, password: centralOptions.password };
  const schemaDatabase = isolation === 'schema' ? (options.schemaDatabase ?? centralOptions.database) : undefined;
  if (isolation === 'schema' && !schemaDatabase) {
    throw new InvalidDatabaseConfigError('isolation: "schema" needs schemaDatabase (or a database in the central URL)');
  }
  const poolOptions = options.pool ?? {};

  let centralConnection: OpenedConnection | undefined;
  let state: State | undefined;

  interface State {
    central: CentralDb;
    raw: AnyKysely;
    pools: ConnectionPoolRegistry;
    servers: ServerRegistry;
    connections: ConnectionManager;
    steps: ProvisioningStepRepository;
    tenantsRepo: KyselyTenantRepository;
    tenantMigrator: Promise<TenancyMigrator | undefined>;
    provisioning?: DatabaseProvisioning;
  }

  const require = (): State => {
    if (!state) throw new InvalidDatabaseConfigError('The database plugin is not set up');
    return state;
  };

  return {
    name: 'database',

    setup(context) {
      centralConnection = driver.connect(
        { ...centralOptions, ssl: options.ssl ?? centralOptions.ssl },
        {
          max: options.central.pool?.max ?? 10,
          onError: (error) =>
            context.observer.reportError('db.pool.error', error, {
              tenantId: null,
              pool: 'central',
            }),
        },
      );
      const raw = centralConnection.db;
      const central: CentralDb = {
        db: raw.withPlugin(new TablePrefixPlugin(tablePrefix)) as unknown as Kysely<CentralTables>,
        kind: driver.kind,
        driver,
      };
      const pools = new ConnectionPoolRegistry({
        maxOpenPools: poolOptions.maxOpenPools ?? 100,
        idleTimeoutMs: poolOptions.idleTimeoutMs ?? 60_000,
        logger: context.logger,
      });
      const serverRepo = new DatabaseServerRepository(central);
      const servers = new ServerRegistry(
        serverRepo,
        encrypter,
        {
          id: options.defaultServerId ?? 'default',
          driver: driver.name,
          host: centralOptions.host,
          port: centralOptions.port,
        },
        admin,
        context.logger,
      );
      const connections = new ConnectionManager({
        driver,
        pools,
        servers,
        encrypter,
        tenantCredentials: options.tenantCredentials,
        poolMax: poolOptions.max ?? 5,
        isolation,
        schemaDatabase,
        onPoolError: (error, pool) =>
          context.observer.reportError('db.pool.error', error, { tenantId: null, pool }),
        ssl: options.ssl,
      });
      const steps = new ProvisioningStepRepository(central);
      const tenantsRepo = new KyselyTenantRepository(central);
      const tenantMigrator = options.migrations?.tenant
        ? toMigrator(options.migrations.tenant, `${tablePrefix}migrations`)
        : Promise.resolve(undefined);
      // Un error aquí (carpeta inexistente...) se registra y aparece al migrar; nunca tumba el proceso.
      tenantMigrator.catch((error: unknown) =>
        context.observer.reportError('database.migrations.load', error, { tenantId: null }),
      );
      state = { central, raw, pools, servers, connections, steps, tenantsRepo, tenantMigrator };

      // El migrador se resuelve una vez (puede leer una carpeta); el pipeline lo espera.
      const lazyMigrator: TenancyMigrator = {
        latest: async (db, c) => (await tenantMigrator)?.latest(db, c) ?? { executed: [] },
        rollback: async (db, o, c) =>
          (await tenantMigrator)?.rollback(db, o, c) ?? { executed: [] },
        status: async (db, c) => (await tenantMigrator)?.status(db, c) ?? [],
      };

      const provisioning = new DatabaseProvisioning({
        driver,
        central: raw,
        connections,
        servers,
        serverRepo,
        steps,
        tenants: tenantsRepo,
        encrypter,
        observer: context.observer,
        events: context.events,
        clock: context.clock,
        ids: context.ids,
        migrator: options.migrations?.tenant ? lazyMigrator : undefined,
        seed: options.seed,
        pipeline: options.pipeline ?? DEFAULT_PIPELINE,
        naming: { prefix: options.prefix ?? 'tenant_', suffix: options.suffix ?? '', tablePrefix },
        credentials,
        placement: options.placement ?? 'least-tenants',
        cleanupOnFailure: options.cleanupOnFailure ?? false,
        lockTimeoutMs: options.lockTimeoutMs ?? 10_000,
        isolation,
        schemaDatabase,
      });
      state.provisioning = provisioning;

      return {
        tenants: tenantsRepo,
        domains: new KyselyDomainRepository(central),
        provisioning,
        bootstrappers: [new DatabaseBootstrapper(connections, servers)],
        healthChecks: [
          { name: 'database', check: async () => void (await sql`SELECT 1`.execute(raw)) },
        ],
        close: async () => {
          await pools.closeAll();
          await centralConnection?.destroy();
        },
      };
    },

    extend(tenancy: Tenancy): DatabaseExtension {
      const lease = () => tenancy.resource<PoolLease>(DATABASE_RESOURCE);
      const observer = tenancy.observability;

      const targets = async (opts: MigrateOptions): Promise<Tenant[] | undefined> => {
        if (!opts.tenants) return undefined;
        const found: Tenant[] = [];
        for (const id of opts.tenants) {
          const tenant = await tenancy.tenants.find(id);
          if (!tenant) throw new TenantNotFoundError(id);
          found.push(tenant);
        }
        return found;
      };

            const migrationContext = (tenant: Tenant): MigrationContext => {
        const connection = require().connections.tenantConnection(tenant);
        return {
          tenant,
          kind: driver.kind,
          connection,
          url: ConnectionManager.toUrl(driver.kind, connection),
          native: lease().native,
          schema: tenant.database?.schema ?? null,
        };
      };

      /** Recorre los tenants (todos o los pedidos) con concurrencia, registrando cada uno. */
      const forTenants = async (
        operation: string,
        opts: MigrateOptions,
        fn: (tenant: Tenant, db: AnyKysely, context: MigrationContext) => Promise<unknown>,
      ): Promise<RunForEachResult> => {
        const list = await targets(opts);
        const statuses: TenantStatus[] = ['active', 'maintenance', 'suspended'];
        const task = async (tenant: Tenant) => {
          const started = performance.now();
          try {
            await fn(tenant, lease().db, migrationContext(tenant));
          } catch (error) {
            opts.onTenant?.({
              tenantId: tenant.id.value,
              ok: false,
              durationMs: performance.now() - started,
              error,
            });
            throw error;
          }
          const durationMs = performance.now() - started;
          observer.logger.info(
            {
              tenantId: tenant.id.value,
              operation,
              outcome: 'success',
              durationMs: Math.round(durationMs),
            },
            `${operation} succeeded`,
          );
          opts.onTenant?.({ tenantId: tenant.id.value, ok: true, durationMs });
        };
        if (!list)
          return tenancy.runForEach(task, { concurrency: opts.concurrency ?? 5, status: statuses });
        const result: RunForEachResult = { succeeded: [], failed: [] };
        for (const tenant of list) {
          try {
            await tenancy.run(tenant, () => task(tenant));
            result.succeeded.push(tenant.id.value);
          } catch (error) {
            observer.report(operation, error, { tenantId: tenant.id.value });
            result.failed.push({ tenantId: tenant.id.value, error });
          }
        }
        return result;
      };

      const migrator = async () => {
        const m = await require().tenantMigrator;
        if (!m)
          throw new InvalidDatabaseConfigError(
            'No tenant migrations configured (migrations.tenant)',
          );
        return m;
      };

      const admin: DatabaseAdmin = {
        async install() {
          const s = require();
          // Candado: varias instancias pueden correr install() a la vez (el migrador de Kysely no bloquea en SQLite).
          const run = await driver.withLock(s.raw, 'tenancy:install', 60_000, () =>
            new KyselyMigrator(
            migrationsFromObject(centralMigrations(tablePrefix, driver.kind)),
            {
              tableName: `${tablePrefix}migrations`,
            },
          ).latest(s.raw),
          );
          await s.servers.registerDefault(new Date());
          observer.logger.info(
            {
              tenantId: null,
              operation: 'database.install',
              outcome: 'success',
              executed: run.executed,
            },
            'Central tables installed',
          );
          return run;
        },
        async migrateCentral() {
          if (!options.migrations?.central) return { executed: [] };
          const m = await toMigrator(
            options.migrations.central,
            `${tablePrefix}central_migrations`,
          );
          return m.latest(require().raw);
        },
        async migrate(opts = {}) {
          const m = await migrator();
          return forTenants('database.migrate', opts, async (tenant, db, context) => {
            const run = await m.latest(db, context);
            if (run.executed.length > 0)
              await tenancy.events.publish(
                'database.migrated',
                TenancyEvents.database('database.migrated', tenant).data,
              );
          });
        },
        async rollback(opts = {}) {
          const m = await migrator();
          return forTenants('database.rollback', opts, (_tenant, db, context) =>
            m.rollback(db, { steps: opts.steps ?? 1 }, context),
          );
        },
        async seed(opts = {}) {
          const seed = options.seed;
          if (!seed) throw new InvalidDatabaseConfigError('No seed configured');
          return forTenants('database.seed', opts, (tenant, db) => seed(db, tenant));
        },
        async status(id) {
          const m = await migrator();
          return tenancy.run(id, async () =>
            m.status(lease().db, migrationContext(tenancy.currentOrFail())),
          );
        },
        servers: {
          add: (input) => require().servers.add(input, new Date()),
          list: () => require().servers.list(),
        },
        async tables() {
          const tenant = tenancy.currentOrFail();
          const schema = tenant.database?.schema;
          // Modo schema: se leen solo las tablas de su schema, no las de miles de tenants.
          const all = schema
            ? await schemaTables(lease().db, schema, { columns: true })
            : await lease().db.introspection.getTables();
          return all
            .filter((t) => !t.isView && !/(^|_)migrations(_lock)?$/.test(t.name))
            // Modo base: toda la base es del tenant. Modo schema: solo su schema.
            .filter((t) => (schema ? t.schema === schema : true))
            .map((t) => ({
              name: t.name,
              schema: t.schema,
              columns: t.columns.map((c) => ({ name: c.name, dataType: c.dataType, isNullable: c.isNullable })),
            }));
        },
        central() {
          const s = require();
          return {
            db: s.central.db,
            raw: s.raw,
            kind: driver.kind,
            tablePrefix,
            encrypter,
            driver,
          };
        },
        connection() {
          const tenant = tenancy.currentOrFail();
          const options = require().connections.tenantConnection(tenant);
          return {
            key: ConnectionManager.tenantKey(tenant),
            kind: driver.kind,
            options,
            url: ConnectionManager.toUrl(driver.kind, options),
            native: lease().native,
            schema: tenant.database?.schema ?? null,
            tenant,
          };
        },
        async connectionUrl(id) {
          const s = require();
          const tenant = await requireTenant(s.tenantsRepo, id);
          if (tenant.database) await s.servers.ensure(tenant.database.serverId);
          return ConnectionManager.toUrl(driver.kind, s.connections.tenantConnection(tenant));
        },
        async provisioningSteps(id) {
          const tenant = await requireTenant(require().tenantsRepo, id);
          return require().steps.list(tenant.id.value);
        },
        pools: () => require().pools.stats(),
        async schema(format) {
          const tables = await introspectTables(require().raw, driver.kind, tablePrefix);
          if (tables.length === 0)
            throw new InvalidDatabaseConfigError(
              'No tenancy tables found: run `tenancy install` first',
            );
          return generateSchema(tables, format, driver.kind);
        },
        async rotateKey() {
          const s = require();
          let updated = 0;
          const rotate = async (table: string, key: string, column: string) => {
            const rows = (await s.raw
              .selectFrom(`${tablePrefix}${table}`)
              .select([key, column])
              .where(column, 'is not', null)
              .execute()) as Record<string, unknown>[];
            for (const row of rows) {
              const value = row[column] as string;
              if (!encrypter.needsRotation(value)) continue;
              await s.raw
                .updateTable(`${tablePrefix}${table}`)
                .set({ [column]: encrypter.rotate(value) })
                .where(key, '=', row[key])
                .execute();
              updated++;
            }
          };
          await rotate('tenants', 'id', 'database_password_encrypted');
          await rotate('database_servers', 'id', 'admin_password_encrypted');
          await rotate('webhook_endpoints', 'id', 'secret_encrypted');
          await rotate('admin_users', 'id', 'two_factor_secret_encrypted');
          observer.logger.info(
            { tenantId: null, operation: 'database.rotateKey', outcome: 'success', updated },
            'Encryption key rotated',
          );
          return { updated };
        },
        move(tenantId, options) {
          return require().provisioning!.move(tenantId, options, {
            maintenance: async (message) => void (await tenancy.tenants.maintenance(tenantId, message)),
            restore: async () => void (await tenancy.tenants.activate(tenantId)),
            invalidate: () => tenancy.tenants.invalidate(tenantId),
          });
        },
      };

      return {
        db: <DB>() => lease().db as Kysely<DB>,
        centralDb: <DB>() => require().raw as Kysely<DB>,
        sql: async <Row>(strings: TemplateStringsArray, ...values: unknown[]) => {
          const result = await sql<Row>(strings, ...values).execute(lease().db);
          return result.rows;
        },
        pool: <P>() => lease().native as P,
        database: admin,
      };
    },
  };
}
