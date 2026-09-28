import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  DecryptionError,
  EncryptionKeyMissingError,
  InvalidEncryptionKeyError,
} from '../errors.js';

const VERSION = 'tn1';
const ALGORITHM = 'aes-256-gcm';

interface Key {
  id: string;
  secret: Buffer;
}

/** Genera una llave nueva para `TENANCY_KEY`. */
export function generateEncryptionKey(): string {
  return `base64:${randomBytes(32).toString('base64')}`;
}

function parseKey(value: string): Key {
  const raw = value.trim();
  let secret: Buffer;
  if (raw.startsWith('base64:')) secret = Buffer.from(raw.slice(7), 'base64');
  else if (/^[0-9a-f]{64}$/i.test(raw)) secret = Buffer.from(raw, 'hex');
  else secret = Buffer.from(raw, 'base64');
  if (secret.length !== 32) {
    throw new InvalidEncryptionKeyError(
      'it must be 32 bytes (use `base64:...` or 64 hex characters)',
    );
  }
  return { id: createHash('sha256').update(secret).digest('hex').slice(0, 8), secret };
}

/**
 * Cifrado AES-256-GCM con rotación de llaves. Cada valor guarda el id de la llave con la que se
 * cifró (`tn1.<kid>.<iv>.<tag>.<datos>`), así una llave nueva puede convivir con las anteriores.
 */
export class Encrypter {
  private readonly current: Key | undefined;
  private readonly keys = new Map<string, Key>();

  constructor(key?: string, previousKeys: readonly string[] = []) {
    this.current = key ? parseKey(key) : undefined;
    for (const k of [...(this.current ? [this.current] : []), ...previousKeys.map(parseKey)]) {
      if (!this.keys.has(k.id)) this.keys.set(k.id, k);
    }
  }

  get hasKey(): boolean {
    return this.current !== undefined;
  }

  get currentKeyId(): string | undefined {
    return this.current?.id;
  }

  encrypt(plain: string): string {
    if (!this.current) throw new EncryptionKeyMissingError();
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.current.secret, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      this.current.id,
      iv.toString('base64url'),
      tag.toString('base64url'),
      data.toString('base64url'),
    ].join('.');
  }

  decrypt(value: string): string {
    const parts = value.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION) throw new DecryptionError('unknown format');
    const [, kid, iv, tag, data] = parts as [string, string, string, string, string];
    const key = this.keys.get(kid);
    if (!key) throw new DecryptionError(`no key with id "${kid}" (was it rotated out?)`);
    try {
      const decipher = createDecipheriv(ALGORITHM, key.secret, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(data, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new DecryptionError('authentication failed (wrong key or tampered value)');
    }
  }

  /** `true` si el valor fue cifrado con una llave que no es la actual. */
  needsRotation(value: string): boolean {
    return value.split('.')[1] !== this.current?.id;
  }

  /** Vuelve a cifrar el valor con la llave actual. */
  rotate(value: string): string {
    return this.encrypt(this.decrypt(value));
  }
}
