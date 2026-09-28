import type { PutOptions, StorageDriver, StoredFile } from '../ports/index.js';

/** Almacenamiento en memoria (tests y prototipos). Las URLs apuntan a `/tenancy/assets/...`. */
export class MemoryStorage implements StorageDriver {
  readonly name = 'memory';
  private readonly files = new Map<string, { data: Uint8Array; modified: Date }>();

  async put(key: string, body: Uint8Array | string, _options?: PutOptions): Promise<void> {
    const data = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
    this.files.set(key, { data, modified: new Date() });
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const file = this.files.get(key);
    return file ? new Uint8Array(file.data) : undefined;
  }

  async exists(key: string): Promise<boolean> {
    return this.files.has(key);
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  async list(prefix: string): Promise<StoredFile[]> {
    return [...this.files.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, f]) => ({ key, size: f.data.byteLength, lastModified: f.modified }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
  }

  async url(key: string): Promise<string> {
    return `/tenancy/assets/${key.split('/').slice(1).map(encodeURIComponent).join('/')}`;
  }
}
