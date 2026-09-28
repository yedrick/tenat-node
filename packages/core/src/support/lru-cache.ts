export interface LruCacheOptions {
  /** Cantidad máxima de entradas. */
  max: number;
  /** Tiempo de vida en ms. `0` = sin vencimiento. */
  ttlMs?: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** LRU simple sobre `Map` (mantiene orden de inserción) con TTL opcional. */
export class LruCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: LruCacheOptions) {
    if (!Number.isInteger(options.max) || options.max < 1)
      throw new RangeError('LruCache max must be >= 1');
    this.max = options.max;
    this.ttlMs = options.ttlMs ?? 0;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== 0 && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V, ttlMs: number = this.ttlMs): this {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: ttlMs > 0 ? this.now() + ttlMs : 0 });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  /** Elimina todas las entradas que cumplan la condición. */
  deleteWhere(predicate: (value: V, key: K) => boolean): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (predicate(entry.value, key)) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  keys(): IterableIterator<K> {
    return this.entries.keys();
  }

  clear(): void {
    this.entries.clear();
  }
}
