import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-tenancy-signature';

/** Secreto nuevo para un endpoint (se muestra una sola vez). */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

/** `t=<unix>,v1=<hex HMAC-SHA256 de "<t>.<body>">` */
export function signWebhook(
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

export interface VerifyOptions {
  secret: string;
  /** Cuerpo crudo tal como llegó (no el JSON re-serializado). */
  body: string;
  /** Valor del header `X-Tenancy-Signature`. */
  header: string | undefined;
  /** Diferencia máxima de reloj aceptada (contra repeticiones). Por defecto 300 s. */
  toleranceSeconds?: number;
  now?: number;
}

/** Verifica la firma de un webhook recibido. Para usar en el servidor que recibe. */
export function verifyWebhook(options: VerifyOptions): boolean {
  if (!options.header) return false;
  const parts = Object.fromEntries(
    options.header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) return false;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(
    signWebhook(options.secret, options.body, timestamp).split('v1=')[1]!,
    'hex',
  );
  const received = Buffer.from(parts.v1, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
