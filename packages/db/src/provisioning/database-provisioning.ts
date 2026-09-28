import {
  Tenant as TenantEntity,
  TenancyEvents,
  TenantId,
  TenantNotFoundError,
  type Clock,
  type EventBus,
  type IdGenerator,
  type Observer,
  type ProvisioningPipeline,
  type Tenant,
  type TenantRepository,
} from '@tenancy-node/core';
import type { ConnectionManager, CredentialsMode } from '../connections.js';
import type { Encrypter } from '../crypto/encrypter.js';
import type { DatabaseDriver } from '../drivers/driver.js';
import {
  DatabaseNameTakenError,
  DatabaseNotAssignedError,
  NoDatabaseServerAvailableError,
  TenantMoveError,
} from '../errors.js';
import { copyTenantData, type CopyOptions } from './copy.js';
import type { AnyKysely } from '../kysely-any.js';
import type { MigrationContext, TenancyMigrator } from '../migrations/migrator.js';
import { ConnectionManager as Connections } from '../connections.js';
import type { ProvisioningStepRepository } from '../repositories/provisioning-step-repository.js';
import type { DatabaseServerRepository } from '../repositories/server-repository.js';
import type { ServerRegistry } from '../servers/server-registry.js';
import { databaseNameFor, generatePassword, usernameFor, type NamingOptions } from './naming.js';
import { hasCapacity, rankServers, type PlacementStrategy } from './placement.js';

export interface StepContext {
  readonly tenant: Tenant;
  /** Conexión a la base del tenant (con sus credenciales). */
  readonly db: AnyKysely;
  /** Conexión de administración del servidor del tenant. */
  readonly admin: AnyKysely;
  /** Datos de conexión para migradores externos. */
  readonly migration: MigrationContext;
}

/** Paso propio del pipeline. Debe ser idempotente: puede volver a correr en un reintento. */
export interface ProvisioningStep {
  readonly name: string;
  run(context: StepContext): Promise<void>;
  /** Deshacer al borrar el tenant (opcional). */
  undo?(context: StepContext): Promise<void>;
}

export type BuiltinStep = 'createDatabase' | 'createUser' | 'migrate' | 'seed';
export type PipelineStep = BuiltinStep | ProvisioningStep;

export interface DatabaseProvisioningDeps {
  driver: DatabaseDriver;
  central: AnyKysely;
  connections: ConnectionManager;
  servers: ServerRegistry;
  serverRepo: DatabaseServerRepository;
  steps: ProvisioningStepRepository;
  tenants: TenantRepository;
  encrypter: Encrypter;
  observer: Observer;
  events: EventBus;
  clock: Clock;
  ids: IdGenerator;
  migrator: TenancyMigrator | undefined;
  seed: ((db: AnyKysely, tenant: Tenant) => Promise<void>) | undefined;
  pipeline: readonly PipelineStep[];
  naming: NamingOptions;
  credentials: CredentialsMode;
  placement: PlacementStrategy;
  cleanupOnFailure: boolean;
  lockTimeoutMs: number;
  isolation: 'database' | 'schema';
  /** Modo schema: base física compartida. */
  schemaDatabase: string | undefined;
}

const CLEANUP = 'cleanup';

export interface MoveOptions extends Omit<CopyOptions, 'onTable'> {
  /** Servidor de destino (id de `tenancy_database_servers`). */
  to: string;
  /** Borrar la base (y el usuario) del servidor de origen al terminar. Por defecto `false`. */
  dropSource?: boolean;
  /** Espera tras poner el tenant en mantenimiento, para que terminen las peticiones en curso. Por defecto 1000 ms. */
  drainMs?: number;
  /** Mensaje de mantenimiento mientras se mueve. */
  maintenanceMessage?: string;
}

/** Lo que el movimiento necesita de la fachada (estado del tenant y cachés de todas las instancias). */
export interface MoveHooks {
  maintenance(message: string): Promise<void>;
  restore(): Promise<void>;
  invalidate(): void;
}

export interface MoveResult {
  tenantId: string;
  from: string;
  to: string;
  database: string;
  rows: Record<string, number>;
  sequencesReset: number;
  sourceDropped: boolean;
}

/** Antes de borrar el rol de un tenant en modo schema hay que quitarle el acceso a la base compartida. */
async function sqlRevoke(admin: AnyKysely, username: string, database: string): Promise<void> {
  const { sql } = await import('kysely');
  const role = `"${username.replace(/"/g, '')}"`;
  await sql.raw(`REVOKE ALL ON DATABASE "${database.replace(/"/g, '')}" FROM ${role}`).execute(admin);
}

/**
 * Aprovisionamiento real (Pipeline): ubicar → crear base → crear usuario → migrar → sembrar → pasos propios.
 * Cada paso queda en `tenancy_provisioning_steps` y en el log. Al reintentar, los pasos que ya
 * terminaron bien se saltan, así un seed no se ejecuta dos veces.
 */
export class DatabaseProvisioning implements ProvisioningPipeline {
  constructor(private readonly deps: DatabaseProvisioningDeps) {}

  provision(tenant: Tenant): Promise<void> {
    const { driver, central, lockTimeoutMs } = this.deps;
    return driver.withLock(central, `tenancy:${tenant.id.value}`, lockTimeoutMs, () =>
      this.run(tenant),
    );
  }

  deprovision(tenant: Tenant): Promise<void> {
    const { driver, central, lockTimeoutMs } = this.deps;
    return driver.withLock(central, `tenancy:${tenant.id.value}`, lockTimeoutMs, () =>
      this.teardown(tenant),
    );
  }

  /**
   * Mueve la base de un tenant a otro servidor: candado → mantenimiento → base y usuario en el
   * destino → migraciones → copia (orden de claves foráneas) → secuencias → verificación de
   * filas → cambio de servidor. Si algo falla, borra lo creado en el destino y el tenant vuelve
   * a su estado; el origen nunca se toca hasta que el destino está verificado.
   */
  move(tenantId: string, options: MoveOptions, hooks: MoveHooks): Promise<MoveResult> {
    const { driver, central, lockTimeoutMs, observer } = this.deps;
    return driver.withLock(central, `tenancy:${tenantId}`, lockTimeoutMs, () =>
      observer.trace('database.move', { tenantId, to: options.to }, () =>
        this.runMove(tenantId, options, hooks),
      ),
    );
  }

  private async runMove(tenantId: string, options: MoveOptions, hooks: MoveHooks): Promise<MoveResult> {
    const { tenants, servers, serverRepo, driver, observer, clock } = this.deps;
    const id = TenantId.create(tenantId);
    const tenant = await tenants.findById(id);
    if (!tenant) throw new TenantNotFoundError(tenantId);
    if (!tenant.database) throw new DatabaseNotAssignedError(tenantId);
    const from = tenant.database.serverId;
    const to = options.to;
    const fail = (reason: string, cause?: unknown) =>
      new TenantMoveError(tenantId, reason, { from, to, ...(cause !== undefined ? { cause } : {}) });
    if (from === to) throw fail(`it is already on server "${to}"`);
    if (!['active', 'maintenance', 'suspended'].includes(tenant.status))
      throw fail(`its status is "${tenant.status}"`);
    const target = await servers.ensure(to);
    if (target.driver !== driver.name && !(driver.kind === 'mysql' && target.driver === 'mariadb'))
      throw fail(`server "${to}" uses the ${target.driver} driver`);
    await servers.ensure(from);

    const moved = TenantEntity.restore({ ...tenant.toSnapshot(), database: { ...tenant.database, serverId: to } });
    const step = <T>(name: string, fn: () => Promise<T>) =>
      observer.trace('database.move.step', { tenantId, step: name, from, to }, fn);

    if (!(await serverRepo.reserveSlot(to))) throw new NoDatabaseServerAvailableError(tenantId);
    const wasActive = tenant.status === 'active';
    let createdTarget = false;
    let result: MoveResult;
    try {
      if (wasActive) {
        await hooks.maintenance(options.maintenanceMessage ?? 'Moving to another database server');
        await new Promise((resolve) => setTimeout(resolve, options.drainMs ?? 1000));
      }
      await step('createDatabase', async () => {
        const exists = await this.withAdmin(
          moved,
          (admin) =>
            moved.database!.schema
              ? driver.schemaExists!(admin, moved.database!.schema)
              : driver.databaseExists(admin, moved.database!.name),
          moved.database!.schema ? this.deps.schemaDatabase : undefined,
        );
        if (exists) throw fail(`"${moved.database!.name}" already exists on server "${to}"`);
        createdTarget = await this.createDatabase(moved);
      });
      await step('createUser', () => this.createUser(moved));
      await step('migrate', () => this.migrate(moved));
      const copied = await step('copy', () =>
        this.withConnections(tenant, (source) =>
          this.withConnections(moved, (destination) =>
            copyTenantData(
              source.db,
              destination.db,
              driver.kind,
              tenant.database!.schema ?? (driver.kind === 'postgres' ? 'public' : ''),
              {
                ...options,
                onTable: (table, rows, durationMs) =>
                  observer.logger.info(
                    { tenantId, operation: 'database.move.table', outcome: 'success', table, rows, durationMs: Math.round(durationMs) },
                    `Copied ${rows} rows of ${table}`,
                  ),
              },
            ),
          ),
        ),
      );
      await step('switch', async () => {
        // Se relee: el estado cambió (mantenimiento) desde que se cargó.
        const fresh = (await tenants.findById(id)) ?? tenant;
        fresh.assignDatabase({ ...fresh.database!, serverId: to }, clock.now());
        await tenants.save(fresh);
      });
      result = {
        tenantId,
        from,
        to,
        database: tenant.database.name,
        rows: copied.rows,
        sequencesReset: copied.sequencesReset,
        sourceDropped: false,
      };
    } catch (error) {
      // Solo se llega aquí antes del cambio de servidor: el tenant sigue en el origen.
      if (createdTarget) {
        await this.dropResources(moved).catch((cleanup: unknown) =>
          observer.reportError('database.move.cleanup', cleanup, { tenantId, server: to }),
        );
      }
      await serverRepo.releaseSlot(to).catch(() => undefined);
      if (wasActive) {
        await hooks.restore().catch((restore: unknown) =>
          observer.reportError('database.move.restore', restore, { tenantId }),
        );
      }
      throw error instanceof TenantMoveError ? error : fail(error instanceof Error ? error.message : String(error), error);
    }

    // Desde aquí el tenant ya vive en el destino: ningún fallo deshace el movimiento ni toca
    // la base nueva. Cada fallo queda en el log y en el registro de errores del tenant.
    const after = async (name: string, fn: () => Promise<unknown> | unknown) => {
      try {
        await fn();
        return true;
      } catch (error) {
        observer.reportError(`database.move.${name}`, error, { tenantId, from, to });
        return false;
      }
    };
    await after('invalidate', () => hooks.invalidate());
    await after('releaseSlot', () => serverRepo.releaseSlot(from));
    await after('closeSource', () => this.deps.connections.closeTenant(tenant));
    // Si falla, el tenant queda movido pero en mantenimiento: se activa a mano (tenants.activate).
    if (wasActive) await after('restore', () => hooks.restore());
    if (options.dropSource) {
      // `step` ya deja el fallo en el log (database.move.step con step=dropSource).
      result.sourceDropped = await step('dropSource', () => this.dropResources(tenant)).then(
        () => true,
        () => false,
      );
    }
    await after('event', () => this.deps.events.publish(TenancyEvents.databaseMoved({ ...result })));
    return result;
  }

  private async run(tenant: Tenant): Promise<void> {
    const { steps, ids, observer } = this.deps;
    const runId = ids.generate();
    const previous = await steps.lastRun(tenant.id.value);
    const cleanedUp = previous.some((s) => s.step === CLEANUP && s.status === 'completed');
    const done = new Set(
      cleanedUp ? [] : previous.filter((s) => s.status === 'completed').map((s) => s.step),
    );
    const attempts = new Map(previous.map((s) => [s.step, s.attempt]));
    let createdDatabase = false;

    const record = async (name: string, fn: () => Promise<'completed' | 'skipped'>) => {
      const attempt = (attempts.get(name) ?? 0) + 1;
      const started = performance.now();
      const id = await steps.start(tenant.id.value, runId, name, attempt, this.deps.clock.now());
      try {
        const status = await observer.trace(
          'provisioning.step',
          { tenantId: tenant.id.value, step: name, runId, attempt },
          fn,
        );
        await steps.finish(id, status, this.deps.clock.now(), performance.now() - started);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await steps.finish(
          id,
          'failed',
          this.deps.clock.now(),
          performance.now() - started,
          message.slice(0, 2000),
        );
        throw error;
      }
    };

    try {
      if (!tenant.database)
        await record('placement', async () => (await this.place(tenant), 'completed'));
      await this.deps.servers.ensure(tenant.database!.serverId);

      for (const step of this.deps.pipeline) {
        const name = typeof step === 'string' ? step : step.name;
        if (done.has(name)) {
          await record(name, async () => 'skipped');
          continue;
        }
        await record(name, async () => {
          if (typeof step !== 'string') {
            await this.withConnections(tenant, (context) => step.run(context));
            return 'completed';
          }
          switch (step) {
            case 'createDatabase': {
              const created = await this.createDatabase(tenant);
              createdDatabase ||= created;
              return 'completed';
            }
            case 'createUser':
              return this.createUser(tenant);
            case 'migrate':
              return this.migrate(tenant);
            case 'seed':
              return this.runSeed(tenant);
          }
        });
      }
    } catch (error) {
      if (this.deps.cleanupOnFailure && createdDatabase) {
        await record(CLEANUP, async () => {
          await this.dropResources(tenant);
          return 'completed';
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  /** Elige servidor, nombre y credenciales, y lo guarda antes de crear nada. */
  private async place(tenant: Tenant): Promise<void> {
    const { servers, serverRepo, driver, naming, clock } = this.deps;
    const name = databaseNameFor(tenant.id.value, naming, driver.maxIdentifierLength);

    const taken = await this.deps.central
      .selectFrom(`${this.tablePrefix()}tenants`)
      .select('id')
      .where('database_name', '=', name)
      .where('id', '!=', tenant.id.value)
      .executeTakeFirst();
    if (taken) throw new DatabaseNameTakenError(tenant.id.value, name);

    const available = (await servers.list()).filter(
      (s) =>
        hasCapacity(s) &&
        (s.driver === driver.name || (driver.kind === 'mysql' && s.driver === 'mariadb')),
    );
    const candidates = await rankServers(this.deps.placement, { tenant, servers: available });
    let serverId: string | undefined;
    for (const candidate of candidates) {
      if (await serverRepo.reserveSlot(candidate)) {
        serverId = candidate;
        break;
      }
    }
    if (!serverId) throw new NoDatabaseServerAvailableError(tenant.id.value);

    const perTenant = this.deps.credentials === 'per-tenant';
    tenant.assignDatabase(
      {
        serverId,
        // Modo schema: `name` identifica el schema en el servidor (la base física es schemaDatabase).
        name,
        schema: this.deps.isolation === 'schema' ? name : null,
        username: perTenant
          ? usernameFor(tenant.id.value, naming.prefix, driver.maxUserLength)
          : null,
        passwordEncrypted: perTenant ? this.deps.encrypter.encrypt(generatePassword()) : null,
      },
      clock.now(),
    );
    await this.deps.tenants.save(tenant);
  }

  private async createDatabase(tenant: Tenant): Promise<boolean> {
    const name = tenant.database!.name;
    const schema = tenant.database!.schema;
    if (schema) {
      return this.withAdmin(
        tenant,
        async (admin) => {
          if (await this.deps.driver.schemaExists!(admin, schema)) return false;
          await this.deps.driver.createSchema!(admin, schema);
          await this.deps.events.publish(TenancyEvents.database('database.created', tenant));
          return true;
        },
        this.deps.schemaDatabase,
      );
    }
    return this.withAdmin(tenant, async (admin) => {
      if (await this.deps.driver.databaseExists(admin, name)) return false;
      await this.deps.driver.createDatabase(admin, name);
      await this.deps.events.publish(TenancyEvents.database('database.created', tenant));
      return true;
    });
  }

  private async createUser(tenant: Tenant): Promise<'completed' | 'skipped'> {
    const database = tenant.database!;
    if (!database.username || !database.passwordEncrypted) return 'skipped';
    const password = this.deps.encrypter.decrypt(database.passwordEncrypted);
    if (database.schema) {
      // Modo schema: rol propio, dueño solo de su schema dentro de la base compartida.
      await this.withAdmin(
        tenant,
        async (admin) => {
          await this.deps.driver.createRole!(admin, database.username!, password);
          await this.deps.driver.grantSchema!(admin, database.username!, database.schema!, this.deps.schemaDatabase!);
        },
        this.deps.schemaDatabase,
      );
      return 'completed';
    }
    await this.withAdmin(tenant, (admin) =>
      this.deps.driver.createUser(admin, database.username!, password, database.name),
    );
    return 'completed';
  }

  private async migrate(tenant: Tenant): Promise<'completed' | 'skipped'> {
    const migrator = this.deps.migrator;
    if (!migrator) return 'skipped';
    await this.withConnections(tenant, ({ db, migration }) => migrator.latest(db, migration));
    await this.deps.events.publish(TenancyEvents.database('database.migrated', tenant));
    return 'completed';
  }

  private async runSeed(tenant: Tenant): Promise<'completed' | 'skipped'> {
    const seed = this.deps.seed;
    if (!seed) return 'skipped';
    await this.withConnections(tenant, ({ db }) => seed(db, tenant));
    await this.deps.events.publish(TenancyEvents.database('database.seeded', tenant));
    return 'completed';
  }

  private async teardown(tenant: Tenant): Promise<void> {
    if (!tenant.database) return;
    await this.deps.servers.ensure(tenant.database.serverId);
    for (const step of [...this.deps.pipeline].reverse()) {
      if (typeof step !== 'string' && step.undo) {
        await this.withConnections(tenant, (context) => step.undo!(context));
      }
    }
    await this.dropResources(tenant);
    await this.deps.serverRepo.releaseSlot(tenant.database.serverId);
    await this.deps.events.publish(TenancyEvents.database('database.deleted', tenant));
  }

  private async dropResources(tenant: Tenant): Promise<void> {
    const database = tenant.database!;
    await this.deps.connections.closeTenant(tenant);
    if (database.schema) {
      await this.withAdmin(
        tenant,
        async (admin) => {
          await this.deps.driver.dropSchema!(admin, database.schema!);
          if (database.username) {
            await sqlRevoke(admin, database.username, this.deps.schemaDatabase!);
            await this.deps.driver.dropUser(admin, database.username);
          }
        },
        this.deps.schemaDatabase,
      );
      return;
    }
    await this.withAdmin(tenant, async (admin) => {
      await this.deps.driver.dropDatabase(admin, database.name);
      if (database.username) await this.deps.driver.dropUser(admin, database.username);
    });
  }

  private async withAdmin<T>(tenant: Tenant, fn: (admin: AnyKysely) => Promise<T>, database?: string): Promise<T> {
    const lease = this.deps.connections.acquireAdmin(tenant.database!.serverId, database ?? this.deps.driver.adminDatabase);
    try {
      return await fn(lease.db);
    } finally {
      lease.release();
    }
  }

  private async withConnections<T>(
    tenant: Tenant,
    fn: (context: StepContext) => Promise<T>,
  ): Promise<T> {
    const lease = this.deps.connections.acquireTenant(tenant);
    try {
      const connection = this.deps.connections.tenantConnection(tenant);
      const migration: MigrationContext = {
        tenant,
        kind: this.deps.driver.kind,
        connection,
        url: Connections.toUrl(this.deps.driver.kind, connection),
        native: lease.native,
        schema: tenant.database!.schema,
      };
      return await this.withAdmin(tenant, (admin) =>
        fn({ tenant, db: lease.db, admin, migration }),
      );
    } finally {
      lease.release();
    }
  }

  private tablePrefix(): string {
    return this.deps.naming.tablePrefix;
  }
}
