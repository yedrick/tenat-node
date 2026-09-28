import { TenancyError } from './tenancy-error.js';

/** El tenant solicitado no existe (o fue eliminado). */
export class TenantNotFoundError extends TenancyError {
  constructor(readonly tenantId: string) {
    super('TENANCY_TENANT_NOT_FOUND', `Tenant "${tenantId}" not found`, { tenantId });
  }
}

/** Se pidió el tenant actual pero no hay ninguno en el contexto. */
export class TenantNotIdentifiedError extends TenancyError {
  constructor(message = 'No tenant could be identified for this context') {
    super('TENANCY_TENANT_NOT_IDENTIFIED', message);
  }
}

export class TenantAlreadyExistsError extends TenancyError {
  constructor(readonly tenantId: string) {
    super('TENANCY_TENANT_ALREADY_EXISTS', `Tenant "${tenantId}" already exists`, { tenantId });
  }
}

export class InvalidTenantIdError extends TenancyError {
  constructor(readonly value: string) {
    super(
      'TENANCY_INVALID_TENANT_ID',
      `Invalid tenant id "${value}": use 2-40 characters from a-z, 0-9, "_" and "-", starting with a letter or digit`,
      { value },
    );
  }
}

export class TenantSuspendedError extends TenancyError {
  constructor(readonly tenantId: string) {
    super('TENANCY_TENANT_SUSPENDED', `Tenant "${tenantId}" is suspended`, { tenantId });
  }
}

export class TenantInMaintenanceError extends TenancyError {
  constructor(
    readonly tenantId: string,
    readonly maintenanceMessage: string | null,
  ) {
    super(
      'TENANCY_TENANT_IN_MAINTENANCE',
      maintenanceMessage ?? `Tenant "${tenantId}" is in maintenance`,
      {
        tenantId,
      },
    );
  }
}

/** El tenant existe pero todavía no está listo (aprovisionando, fallido o borrándose). */
export class TenantNotReadyError extends TenancyError {
  constructor(
    readonly tenantId: string,
    readonly status: string,
  ) {
    super('TENANCY_TENANT_NOT_READY', `Tenant "${tenantId}" is not ready (status: ${status})`, {
      tenantId,
      status,
    });
  }
}

export class InvalidTenantStatusTransitionError extends TenancyError {
  constructor(
    readonly tenantId: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(
      'TENANCY_INVALID_STATUS_TRANSITION',
      `Tenant "${tenantId}" cannot change from "${from}" to "${to}"`,
      { tenantId, from, to },
    );
  }
}

export class InvalidDomainError extends TenancyError {
  constructor(readonly value: string) {
    super('TENANCY_INVALID_DOMAIN', `Invalid domain name "${value}"`, { value });
  }
}

export class DomainAlreadyTakenError extends TenancyError {
  constructor(readonly domain: string) {
    super('TENANCY_DOMAIN_TAKEN', `Domain "${domain}" is already in use`, { domain });
  }
}

export class DomainNotFoundError extends TenancyError {
  constructor(readonly domain: string) {
    super('TENANCY_DOMAIN_NOT_FOUND', `Domain "${domain}" not found`, { domain });
  }
}

export class InvalidColorError extends TenancyError {
  constructor(readonly value: string) {
    super('TENANCY_INVALID_COLOR', `Invalid hex color "${value}"`, { value });
  }
}

export class InvalidThemeError extends TenancyError {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super('TENANCY_INVALID_THEME', `Invalid theme field "${field}": ${reason}`, { field });
  }
}

export class InvalidTenantDataError extends TenancyError {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super('TENANCY_INVALID_TENANT_DATA', `Invalid tenant field "${field}": ${reason}`, { field });
  }
}

export class TenantProvisioningError extends TenancyError {
  constructor(
    readonly tenantId: string,
    cause: unknown,
  ) {
    super(
      'TENANCY_PROVISIONING_FAILED',
      `Provisioning of tenant "${tenantId}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { tenantId },
      {
        cause,
      },
    );
  }
}

export class InvalidConfigError extends TenancyError {
  constructor(message: string) {
    super('TENANCY_INVALID_CONFIG', message);
  }
}
