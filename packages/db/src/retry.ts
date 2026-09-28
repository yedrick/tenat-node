import type { DatabaseDriver } from './drivers/driver.js';

/**
 * Reintenta una transacción si falla por un error transitorio (deadlock, espera de lock).
 * Con `SKIP LOCKED` en InnoDB pueden aparecer deadlocks ocasionales al actualizar índices.
 */
export async function withTransientRetry<T>(
  driver: DatabaseDriver,
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !driver.isTransientError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40 * attempt));
    }
  }
}
