import type { Logger } from '@tenancy-node/core';
import type { Credentials } from '../connection.js';
import type { Encrypter } from '../crypto/encrypter.js';
import { DatabaseServerNotFoundError } from '../errors.js';
import type {
  DatabaseServer,
  DatabaseServerRepository,
} from '../repositories/server-repository.js';

export interface DefaultServer {
  id: string;
  driver: string;
  host: string;
  port: number;
}

export interface AddServerInput {
  id: string;
  host: string;
  port?: number;
  adminUsername?: string;
  adminPassword?: string;
  maxTenants?: number | null;
  weight?: number;
  isActive?: boolean;
}

/**
 * Servidores de base de datos disponibles. Se cargan una vez y se consultan de forma síncrona
 * en cada petición (`tenancy.db()` no puede esperar a la base central).
 */
export class ServerRegistry {
  private readonly cache = new Map<string, DatabaseServer>();
  private loading: Promise<void> | undefined;

  constructor(
    private readonly repo: DatabaseServerRepository,
    private readonly encrypter: Encrypter,
    private readonly defaults: DefaultServer,
    private readonly admin: Credentials,
    private readonly logger: Logger,
  ) {
    this.cache.set(defaults.id, {
      ...defaults,
      adminUsername: null,
      adminPasswordEncrypted: null,
      maxTenants: null,
      tenantCount: 0,
      weight: 1,
      isActive: true,
    });
  }

  get defaultServer(): DefaultServer {
    return this.defaults;
  }

  /** Recarga los servidores desde la base central. */
  load(): Promise<void> {
    this.loading ??= this.repo
      .list()
      .then((servers) => {
        for (const server of servers) this.cache.set(server.id, server);
      })
      .catch((error: unknown) => {
        // Antes de `install()` la tabla no existe; se sigue con el servidor por defecto.
        this.logger.debug(
          { operation: 'db.servers.load', err: error },
          'Could not load database servers',
        );
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  async ensure(id: string): Promise<DatabaseServer> {
    if (!this.cache.has(id)) await this.load();
    return this.get(id);
  }

  get(id: string): DatabaseServer {
    const server = this.cache.get(id);
    if (!server) throw new DatabaseServerNotFoundError(id);
    return server;
  }

  /** Lista actualizada (con `tenant_count`) desde la base central. */
  async list(): Promise<DatabaseServer[]> {
    const servers = await this.repo.list();
    for (const server of servers) this.cache.set(server.id, server);
    return servers;
  }

  async add(input: AddServerInput, now: Date): Promise<DatabaseServer> {
    await this.repo.upsert(
      {
        id: input.id,
        driver: this.defaults.driver,
        host: input.host,
        port: input.port ?? this.defaults.port,
        adminUsername: input.adminUsername ?? null,
        adminPasswordEncrypted: input.adminPassword
          ? this.encrypter.encrypt(input.adminPassword)
          : null,
        maxTenants: input.maxTenants ?? null,
        weight: input.weight ?? 1,
        isActive: input.isActive ?? true,
      },
      now,
    );
    const server = (await this.repo.find(input.id))!;
    this.cache.set(server.id, server);
    return server;
  }

  /** Guarda el servidor por defecto de la configuración en la tabla (lo hace `install()`). */
  async registerDefault(now: Date): Promise<void> {
    const existing = await this.repo.find(this.defaults.id);
    await this.repo.upsert(
      {
        ...this.defaults,
        adminUsername: existing?.adminUsername ?? null,
        adminPasswordEncrypted: existing?.adminPasswordEncrypted ?? null,
        maxTenants: existing?.maxTenants ?? null,
        weight: existing?.weight ?? 1,
        isActive: existing?.isActive ?? true,
      },
      now,
    );
    await this.load();
  }

  /** Credenciales de administrador (CREATE DATABASE) de un servidor. */
  adminCredentials(server: DatabaseServer): Credentials {
    if (!server.adminUsername) return this.admin;
    return {
      user: server.adminUsername,
      password: server.adminPasswordEncrypted
        ? this.encrypter.decrypt(server.adminPasswordEncrypted)
        : undefined,
    };
  }
}
