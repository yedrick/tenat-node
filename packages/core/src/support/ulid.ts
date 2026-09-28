import { randomBytes } from 'node:crypto';
import type { IdGenerator } from '../ports/index.js';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generador de ULID (26 caracteres, ordenables por tiempo).
 * Monótono dentro del mismo milisegundo.
 */
export class UlidGenerator implements IdGenerator {
  private lastTime = -1;
  private lastRandom = new Uint8Array(10);

  constructor(private readonly now: () => number = Date.now) {}

  generate(): string {
    const time = this.now();
    if (time === this.lastTime) {
      incrementBytes(this.lastRandom);
    } else {
      this.lastTime = time;
      this.lastRandom = new Uint8Array(randomBytes(10));
    }
    return encodeTime(time) + encodeRandom(this.lastRandom);
  }
}

function encodeTime(time: number): string {
  let value = time;
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = ENCODING[value % 32]! + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits → 16 caracteres de 5 bits
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out = ENCODING[Number(bits & 31n)]! + out;
    bits >>= 5n;
  }
  return out;
}

function incrementBytes(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i]! < 255) {
      bytes[i]! += 1;
      return;
    }
    bytes[i] = 0;
  }
}
