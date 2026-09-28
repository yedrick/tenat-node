import { randomBytes } from 'node:crypto';

/** Mismo formato que `generateEncryptionKey()` de @tenancy-node/db, sin depender de ese paquete. */
export function generateEncryptionKeyValue(): string {
  return `base64:${randomBytes(32).toString('base64')}`;
}
