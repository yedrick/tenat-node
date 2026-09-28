import { TenancyError, type Tenancy } from '@tenancy-node/core';
import type { DatabaseExtension } from '@tenancy-node/db';
import { sha256 } from './auth/sessions.js';

export class InvalidImpersonationTokenError extends TenancyError {
  constructor() {
    super(
      'TENANCY_INVALID_IMPERSONATION_TOKEN',
      'The impersonation token is invalid, expired or already used',
    );
  }
}

export interface Impersonation {
  userIdentifier: string;
  redirectPath: string;
  adminUserId: number;
}

/**
 * Para la app del tenant: canjea un token de "entrar como". Es de un solo uso (se marca como usado
 * en la misma sentencia), vence rápido y solo vale en el tenant para el que se creó.
 * Tu app inicia la sesión de `userIdentifier` y redirige a `redirectPath`.
 */
export async function consumeImpersonationToken(
  tenancy: Tenancy,
  token: string,
): Promise<Impersonation> {
  const t = tenancy as Tenancy & Partial<DatabaseExtension>;
  if (!t.database) throw new Error('consumeImpersonationToken needs the database plugin');
  const tenant = tenancy.currentOrFail();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new InvalidImpersonationTokenError();
  const { db } = t.database.central();
  const hash = sha256(token);
  const now = new Date();
  const result = await db
    .updateTable('impersonation_tokens')
    .set({ used_at: now })
    .where('token_hash', '=', hash)
    .where('tenant_id', '=', tenant.id.value)
    .where('used_at', 'is', null)
    .where('expires_at', '>', now)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) !== 1) throw new InvalidImpersonationTokenError();
  const row = await db
    .selectFrom('impersonation_tokens')
    .selectAll()
    .where('token_hash', '=', hash)
    .executeTakeFirstOrThrow();
  tenancy.observability.logger.warn(
    {
      tenantId: tenant.id.value,
      operation: 'admin.impersonation_used',
      adminUserId: Number(row.admin_user_id),
      user: row.user_identifier,
    },
    'Impersonation token used',
  );
  return {
    userIdentifier: row.user_identifier,
    redirectPath: row.redirect_path,
    adminUserId: Number(row.admin_user_id),
  };
}
