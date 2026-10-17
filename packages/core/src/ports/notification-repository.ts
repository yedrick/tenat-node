import type { Notification, NotificationDevice } from '../domain/index.js';
import type { Page } from './tenant-repository.js';

/** Avisos de la plataforma y quién los leyó. La base central los guarda con `@tenancy-node/db`. */
export interface NotificationRepository {
  insert(notification: Notification): Promise<void>;
  findById(id: string): Promise<Notification | undefined>;
  /** Más nuevos primero. */
  list(query?: { page?: number; perPage?: number }): Promise<Page<Notification>>;
  /** Avisos vigentes en `now` (ya empezaron y no vencieron), de cualquier audiencia. */
  active(now: Date): Promise<Notification[]>;
  /** `true` si existía. Borra también sus lecturas. */
  delete(id: string): Promise<boolean>;
  /** Marca leídos (idempotente). */
  markRead(
    entries: readonly { notificationId: string; tenantId: string; userId: string }[],
    now: Date,
  ): Promise<void>;
  /** De `notificationIds`, cuáles leyó el usuario de ese tenant. */
  readIds(
    tenantId: string,
    userId: string,
    notificationIds: readonly string[],
  ): Promise<Set<string>>;
  /** Lecturas por aviso: tenants distintos y usuarios. */
  readStats(
    notificationIds: readonly string[],
  ): Promise<Map<string, { tenants: number; users: number }>>;
  /** Guarda o actualiza un dispositivo (por `token`). */
  saveDevice(device: NotificationDevice): Promise<void>;
  /** Borra dispositivos por token. Devuelve cuántos borró. */
  deleteDevices(tokens: readonly string[]): Promise<number>;
  /** Dispositivos de estos tenants (y opcionalmente de un usuario). */
  devices(tenantIds: readonly string[], userId?: string): Promise<NotificationDevice[]>;
}
