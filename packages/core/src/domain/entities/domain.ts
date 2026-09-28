import type { DomainName } from '../value-objects/domain-name.js';
import type { TenantId } from '../value-objects/tenant-id.js';

/** Un dominio que apunta a un tenant ('bolivar.tuapp.com' → bolivar). */
export interface Domain {
  readonly id: number;
  readonly domain: DomainName;
  readonly tenantId: TenantId;
  readonly isPrimary: boolean;
  readonly verifiedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
