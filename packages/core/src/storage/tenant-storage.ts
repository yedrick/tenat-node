import { TenancyError, type Tenant } from '../domain/index.js';
import type { Bootstrapper, PutOptions, StorageDriver } from '../ports/index.js';

export class InvalidStoragePathError extends TenancyError {
  constructor(readonly path: string) {
    super('TENANCY_INVALID_STORAGE_PATH', `Invalid storage path "${path}"`, { path });
  }
}

/**
 * Normaliza una ruta relativa y rechaza todo lo que podría salir de la carpeta del tenant:
 * `..`, rutas absolutas, `\`, bytes nulos y rutas vacías.
 */
export function normalizeStoragePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024)
    throw new InvalidStoragePathError(String(path));
  if (path.includes('\0') || path.includes('\\') || path.startsWith('/'))
    throw new InvalidStoragePathError(path);
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.some((p) => p === '..')) throw new InvalidStoragePathError(path);
  return parts.join('/');
}

export const CENTRAL_STORAGE_PREFIX = 'central/';

export function tenantStoragePrefix(tenantId: string): string {
  return `${tenantId}/`;
}

/** Archivos aislados del tenant del contexto: todas las llaves llevan el prefijo `{id}/`. */
export class TenantStorage {
  readonly prefix: string;

  constructor(
    private readonly driver: StorageDriver,
    readonly tenantId: string | null,
  ) {
    this.prefix = tenantId === null ? CENTRAL_STORAGE_PREFIX : tenantStoragePrefix(tenantId);
  }

  /** Llave completa en el driver para una ruta del tenant. */
  key(path: string): string {
    return this.prefix + normalizeStoragePath(path);
  }

  async put(path: string, body: Uint8Array | string, options?: PutOptions): Promise<void> {
    return this.driver.put(this.key(path), body, options);
  }

  async get(path: string): Promise<Uint8Array | undefined> {
    return this.driver.get(this.key(path));
  }

  async getText(path: string): Promise<string | undefined> {
    const data = await this.get(path);
    return data === undefined ? undefined : Buffer.from(data).toString('utf8');
  }

  async exists(path: string): Promise<boolean> {
    return this.driver.exists(this.key(path));
  }

  async delete(path: string): Promise<void> {
    return this.driver.delete(this.key(path));
  }

  /** Rutas (relativas al tenant) dentro de `directory`. */
  async list(directory = ''): Promise<{ path: string; size: number; lastModified: Date | null }[]> {
    const prefix = directory ? `${this.key(directory)}/` : this.prefix;
    const files = await this.driver.list(prefix);
    return files.map((f) => ({
      path: f.key.slice(this.prefix.length),
      size: f.size,
      lastModified: f.lastModified,
    }));
  }

  /** URL de descarga. Si `path` ya es una URL absoluta, se devuelve igual. */
  async url(path: string, options?: { expiresInSeconds?: number }): Promise<string> {
    if (/^https?:\/\//i.test(path)) return path;
    return this.driver.url(this.key(path), options);
  }

  /** Borra todos los archivos del tenant. */
  async deleteAll(): Promise<void> {
    await this.driver.deletePrefix(this.prefix);
  }
}

export const STORAGE_RESOURCE = 'storage';

export class StorageBootstrapper implements Bootstrapper<TenantStorage> {
  readonly name = STORAGE_RESOURCE;

  constructor(private readonly driver: StorageDriver) {}

  bootstrap(tenant: Tenant | null): TenantStorage {
    return new TenantStorage(this.driver, tenant ? tenant.id.value : null);
  }
}
