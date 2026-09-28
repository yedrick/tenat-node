/** Límite de intentos en memoria (por IP y por email). Ventana fija. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** `true` si todavía hay intentos disponibles para la llave. */
  allowed(key: string, now = Date.now()): boolean {
    const hit = this.hits.get(key);
    return !hit || hit.resetAt <= now || hit.count < this.max;
  }

  fail(key: string, now = Date.now()): void {
    const hit = this.hits.get(key);
    if (!hit || hit.resetAt <= now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else hit.count++;
    if (this.hits.size > 10_000) {
      for (const [k, h] of this.hits) if (h.resetAt <= now) this.hits.delete(k);
    }
  }

  clear(): void {
    this.hits.clear();
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  retryAfterSeconds(key: string, now = Date.now()): number {
    const hit = this.hits.get(key);
    return hit ? Math.max(1, Math.ceil((hit.resetAt - now) / 1000)) : 0;
  }
}
