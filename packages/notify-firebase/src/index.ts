import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  InvalidConfigError,
  forEachConcurrent,
  type Notification,
  type NotificationChannel,
  type NotificationDevice,
} from '@tenancy-node/core';

/** Cuenta de servicio de Firebase (el JSON que se descarga de la consola). */
export interface FirebaseServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface FirebaseOptions {
  /** El JSON de la cuenta de servicio (objeto, texto JSON o ruta del archivo). */
  serviceAccount: FirebaseServiceAccount | string;
  /** Por defecto, `project_id` de la cuenta de servicio. */
  projectId?: string;
  /** Envíos en paralelo. Por defecto 20. */
  concurrency?: number;
  /** URL que abre la notificación en la web si el aviso no tiene enlace (por ejemplo `/avisos`). */
  defaultLink?: string;
  /** Datos extra en `message.data` (solo texto). Por defecto `notificationId`, `level` y `link`. */
  data?: (notification: Notification) => Record<string, string>;
  /** Para pruebas o un proxy. */
  endpoints?: { token?: string; api?: string };
  fetch?: typeof fetch;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_URL = 'https://fcm.googleapis.com';
/** Errores de FCM que significan "este token ya no sirve": se borra el dispositivo. */
const DEAD_TOKEN = new Set(['UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH']);

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

function loadAccount(input: FirebaseServiceAccount | string): FirebaseServiceAccount {
  let account: unknown = input;
  if (typeof input === 'string') {
    const text = input.trim().startsWith('{') ? input : readFileSync(input, 'utf8');
    try {
      account = JSON.parse(text);
    } catch {
      throw new InvalidConfigError('firebase: serviceAccount is not valid JSON');
    }
  }
  const a = account as Partial<FirebaseServiceAccount>;
  if (!a || typeof a.client_email !== 'string' || typeof a.private_key !== 'string')
    throw new InvalidConfigError('firebase: serviceAccount needs client_email and private_key');
  return {
    project_id: a.project_id ?? '',
    client_email: a.client_email,
    // En variables de entorno los saltos de línea suelen venir como "\n".
    private_key: a.private_key.replace(/\\n/g, '\n'),
  };
}

/**
 * Canal de Firebase Cloud Messaging (API HTTP v1): entrega los avisos como notificaciones push
 * a los dispositivos registrados con `tenancy.notifications.devices.register()`.
 *
 * ```ts
 * createTenancy({ notifications: { channels: [firebase({ serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT! })] } });
 * ```
 */
export function firebase(options: FirebaseOptions): NotificationChannel {
  const account = loadAccount(options.serviceAccount);
  const projectId = options.projectId ?? account.project_id;
  if (!projectId) throw new InvalidConfigError('firebase: projectId is required');
  const doFetch = options.fetch ?? fetch;
  const tokenUrl = options.endpoints?.token ?? TOKEN_URL;
  const apiUrl = (options.endpoints?.api ?? API_URL).replace(/\/$/, '');
  const concurrency = options.concurrency ?? 20;
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  const accessToken = async (): Promise<string> => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    pending ??= (async () => {
      try {
        const now = Math.floor(Date.now() / 1000);
        const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const claims = base64url(
          JSON.stringify({
            iss: account.client_email,
            scope: SCOPE,
            aud: tokenUrl,
            iat: now,
            exp: now + 3600,
          }),
        );
        const signature = createSign('RSA-SHA256')
          .update(`${header}.${claims}`)
          .sign(account.private_key)
          .toString('base64url');
        const res = await doFetch(tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: `${header}.${claims}.${signature}`,
          }),
        });
        if (!res.ok)
          throw new Error(`firebase: token request failed (${res.status}): ${await res.text()}`);
        const body = (await res.json()) as { access_token: string; expires_in?: number };
        cached = {
          token: body.access_token,
          expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
        };
        return body.access_token;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };

  const message = (n: Notification, device: NotificationDevice) => {
    const link = n.link?.url ?? options.defaultLink;
    const data = options.data?.(n) ?? {
      notificationId: n.id,
      level: n.level,
      ...(link ? { link } : {}),
    };
    return {
      message: {
        token: device.token,
        notification: { title: n.title, ...(n.body ? { body: n.body } : {}) },
        data,
        android: { priority: n.level === 'critical' ? 'high' : 'normal' },
        apns: { headers: { 'apns-priority': n.level === 'critical' ? '10' : '5' } },
        // fcm_options.link solo acepta HTTPS absolutas.
        ...(link?.startsWith('https://') ? { webpush: { fcm_options: { link } } } : {}),
      },
    };
  };

  return {
    name: 'firebase',
    async send(notification, devices) {
      let sent = 0;
      let failed = 0;
      const invalidTokens: string[] = [];
      if (devices.length === 0) return { sent, failed, invalidTokens };
      const token = await accessToken();
      let lastError: string | undefined;
      await forEachConcurrent(devices, concurrency, async (device) => {
        const res = await doFetch(`${apiUrl}/v1/projects/${projectId}/messages:send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(message(notification, device)),
        });
        if (res.ok) {
          sent++;
          return;
        }
        failed++;
        const text = await res.text();
        let code: string | undefined;
        try {
          const body = JSON.parse(text) as {
            error?: { status?: string; details?: { errorCode?: string }[] };
          };
          code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status;
        } catch {
          code = undefined;
        }
        if (res.status === 404 || (code && DEAD_TOKEN.has(code))) invalidTokens.push(device.token);
        else lastError = `${res.status} ${code ?? text.slice(0, 200)}`;
      });
      // Credenciales o proyecto mal configurados: todo falló por la misma razón.
      if (sent === 0 && invalidTokens.length === 0 && lastError)
        throw new Error(`firebase: every message failed (last: ${lastError})`);
      return { sent, failed, invalidTokens };
    },
  };
}

/**
 * `firebase()` desde variables de entorno: `FIREBASE_SERVICE_ACCOUNT` (el JSON) o
 * `GOOGLE_APPLICATION_CREDENTIALS` (ruta del archivo). `undefined` si no hay ninguna,
 * así la app arranca sin push hasta que configures Firebase.
 */
export function firebaseFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: Omit<FirebaseOptions, 'serviceAccount'> = {},
): NotificationChannel | undefined {
  const serviceAccount = env.FIREBASE_SERVICE_ACCOUNT || env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!serviceAccount) return undefined;
  return firebase({
    serviceAccount,
    ...(env.FIREBASE_PROJECT_ID ? { projectId: env.FIREBASE_PROJECT_ID } : {}),
    ...options,
  });
}
