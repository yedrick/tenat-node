import { hash, verify } from '@node-rs/argon2';
import { AdminHttpError } from '../http.js';

export const MIN_PASSWORD_LENGTH = 12;

/** argon2id con los parámetros recomendados por OWASP (19 MiB, 2 iteraciones). */
export function hashPassword(password: string): Promise<string> {
  assertStrongPassword(password);
  return hash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

export function assertStrongPassword(password: string): void {
  if (
    typeof password !== 'string' ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > 256
  ) {
    throw new AdminHttpError(
      422,
      'ADMIN_WEAK_PASSWORD',
      `The password must have between ${MIN_PASSWORD_LENGTH} and 256 characters`,
    );
  }
}

let dummy: Promise<string> | undefined;

/**
 * Verifica contra un hash real de una contraseña que nadie tiene: así un login con un email
 * inexistente tarda lo mismo que uno con el email correcto (no se puede adivinar qué emails existen).
 */
export async function dummyVerify(password: string): Promise<false> {
  dummy ??= hash('tenancy-node:dummy-password-for-timing', {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  await verify(await dummy, password).catch(() => false);
  return false;
}
