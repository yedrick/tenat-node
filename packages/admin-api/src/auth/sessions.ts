import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CentralAccess } from '@tenancy-node/db';
import { toUser, type AdminUser } from './users.js';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Sesiones del panel: el token solo existe en la cookie del navegador; en la base, su SHA-256. */
export class AdminSessions {
  constructor(
    private readonly central: CentralAccess,
    private readonly secret: string,
    private readonly ttlMs: number,
  ) {}

  async create(
    userId: number,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{ token: string; id: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const id = sha256(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    await this.central.db
      .insertInto('admin_sessions')
      .values({
        id,
        admin_user_id: userId,
        ip,
        user_agent: userAgent?.slice(0, 255) ?? null,
        expires_at: expiresAt,
        created_at: now,
      })
      .execute();
    return { token, id, expiresAt };
  }

  /** Usuario de un token válido (sesión vigente y usuario activo). */
  async resolve(token: string): Promise<{ user: AdminUser; sessionId: string } | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const id = sha256(token);
    const row = await this.central.db
      .selectFrom('admin_sessions')
      .innerJoin('admin_users', 'admin_users.id', 'admin_sessions.admin_user_id')
      .selectAll('admin_users')
      .select(['admin_sessions.expires_at as session_expires_at'])
      .where('admin_sessions.id', '=', id)
      .executeTakeFirst();
    if (!row || new Date(row.session_expires_at as Date).getTime() <= Date.now()) return undefined;
    const user = toUser(row as never);
    return user.isActive ? { user, sessionId: id } : undefined;
  }

  async destroy(sessionId: string): Promise<void> {
    await this.central.db.deleteFrom('admin_sessions').where('id', '=', sessionId).execute();
  }

  /** Cierra todas las sesiones de un usuario (cambio de contraseña, desactivación). */
  async destroyForUser(userId: number, except?: string): Promise<void> {
    let query = this.central.db.deleteFrom('admin_sessions').where('admin_user_id', '=', userId);
    if (except) query = query.where('id', '!=', except);
    await query.execute();
  }

  async purgeExpired(): Promise<number> {
    const result = await this.central.db
      .deleteFrom('admin_sessions')
      .where('expires_at', '<=', new Date())
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** Token CSRF de la sesión (se manda en `X-CSRF-Token` en las peticiones que cambian algo). */
  csrfToken(sessionId: string): string {
    return createHmac('sha256', this.secret).update(`csrf:${sessionId}`).digest('base64url');
  }

  verifyCsrf(sessionId: string, token: string | undefined): boolean {
    if (!token) return false;
    const expected = Buffer.from(this.csrfToken(sessionId));
    const received = Buffer.from(token);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }
}
