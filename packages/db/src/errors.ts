import { TenancyError } from '@tenancy-node/core';

export class EncryptionKeyMissingError extends TenancyError {
  constructor() {
    super(
      'TENANCY_ENCRYPTION_KEY_MISSING',
      'An encryption key is required: set `encryptionKey` (TENANCY_KEY)',
    );
  }
}

export class InvalidEncryptionKeyError extends TenancyError {
  constructor(reason: string) {
    super('TENANCY_INVALID_ENCRYPTION_KEY', `Invalid encryption key: ${reason}`);
  }
}

export class DecryptionError extends TenancyError {
  constructor(reason: string) {
    super('TENANCY_DECRYPTION_FAILED', `Could not decrypt value: ${reason}`);
  }
}

export class DatabaseNotAssignedError extends TenancyError {
  constructor(readonly tenantId: string) {
    super(
      'TENANCY_DATABASE_NOT_ASSIGNED',
      `Tenant "${tenantId}" has no database yet (is it provisioned?)`,
      {
        tenantId,
      },
    );
  }
}

export class DatabaseServerNotFoundError extends TenancyError {
  constructor(readonly serverId: string) {
    super('TENANCY_DATABASE_SERVER_NOT_FOUND', `Database server "${serverId}" not found`, {
      serverId,
    });
  }
}

export class NoDatabaseServerAvailableError extends TenancyError {
  constructor(readonly tenantId: string) {
    super(
      'TENANCY_NO_DATABASE_SERVER_AVAILABLE',
      `No active database server with free capacity for tenant "${tenantId}"`,
      { tenantId },
    );
  }
}

export class DatabaseNameTakenError extends TenancyError {
  constructor(
    readonly tenantId: string,
    readonly database: string,
  ) {
    super(
      'TENANCY_DATABASE_NAME_TAKEN',
      `Database name "${database}" is already used by another tenant`,
      {
        tenantId,
        database,
      },
    );
  }
}

export class LockTimeoutError extends TenancyError {
  constructor(readonly key: string) {
    super('TENANCY_LOCK_TIMEOUT', `Could not acquire lock "${key}" in time`, { key });
  }
}

export class MigrationFailedError extends TenancyError {
  constructor(
    readonly migration: string | undefined,
    cause: unknown,
    tenantId?: string,
  ) {
    super(
      'TENANCY_MIGRATION_FAILED',
      `Migration ${migration ? `"${migration}" ` : ''}failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      tenantId ? { tenantId, migration } : { migration },
      { cause },
    );
  }
}

export class InvalidDatabaseConfigError extends TenancyError {
  constructor(message: string) {
    super('TENANCY_INVALID_DATABASE_CONFIG', message);
  }
}

export class TenantMoveError extends TenancyError {
  constructor(
    readonly tenantId: string,
    reason: string,
    options: { from?: string; to?: string; cause?: unknown } = {},
  ) {
    super('TENANCY_TENANT_MOVE_FAILED', `Could not move tenant "${tenantId}": ${reason}`, {
      tenantId,
      ...(options.from ? { from: options.from } : {}),
      ...(options.to ? { to: options.to } : {}),
    }, options.cause !== undefined ? { cause: options.cause } : undefined);
  }
}
