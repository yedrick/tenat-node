import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PutOptions, StorageDriver, StoredFile } from '../ports/index.js';

export interface LocalStorageOptions {
  /** Carpeta raíz. Por defecto `./storage`. */
  root?: string;
  /**
   * URL pública de una llave. Por defecto `/tenancy/assets/<ruta dentro del tenant>`,
   * que sirve la ruta opcional `http.assets`.
   */
  url?: (key: string) => string;
}

/** Driver de disco local: `storage/bolivar/logo.png`. */
export class LocalStorage implements StorageDriver {
  readonly name = 'local';
  readonly root: string;
  private readonly toUrl: (key: string) => string;

  constructor(options: LocalStorageOptions = {}) {
    this.root = path.resolve(options.root ?? 'storage');
    this.toUrl =
      options.url ??
      ((key) => `/tenancy/assets/${key.split('/').slice(1).map(encodeURIComponent).join('/')}`);
  }

  /** Ruta en disco; verifica que quede dentro de la raíz aunque la llave venga manipulada. */
  private file(key: string): string {
    const target = path.resolve(this.root, key);
    if (target !== this.root && !target.startsWith(this.root + path.sep))
      throw new Error(`Key escapes storage root: ${key}`);
    return target;
  }

  async put(key: string, body: Uint8Array | string, _options?: PutOptions): Promise<void> {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.file(key)));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (error as NodeJS.ErrnoException).code === 'EISDIR'
      )
        return undefined;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.file(key))).isFile();
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }

  async list(prefix: string): Promise<StoredFile[]> {
    const files: StoredFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          const key = path.relative(this.root, full).split(path.sep).join('/');
          if (!key.startsWith(prefix)) continue;
          const info = await stat(full);
          files.push({ key, size: info.size, lastModified: info.mtime });
        }
      }
    };
    // Se recorre solo la carpeta más profunda que contiene el prefijo.
    const base = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
    await walk(this.file(base || '.'));
    return files.sort((a, b) => a.key.localeCompare(b.key));
  }

  async deletePrefix(prefix: string): Promise<void> {
    if (prefix.endsWith('/')) {
      await rm(this.file(prefix.slice(0, -1)), { recursive: true, force: true });
      return;
    }
    for (const file of await this.list(prefix)) await this.delete(file.key);
  }

  async url(key: string): Promise<string> {
    return this.toUrl(key);
  }

  async ping(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }
}
