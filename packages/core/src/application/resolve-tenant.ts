import type { Tenant } from '../domain/index.js';
import type { DomainReader, RequestLike, TenantReader, TenantResolver } from '../ports/index.js';
import { hostnameOf } from './request-host.js';
import { assertTenantAccessible, requireTenant } from './shared.js';

export type Resolution =
  | { readonly kind: 'central' }
  | { readonly kind: 'tenant'; readonly tenant: Tenant }
  | { readonly kind: 'unidentified' };

/**
 * Identifica el tenant de una petición:
 * 1. Un dominio central nunca resuelve a un tenant.
 * 2. Se prueba el resolver configurado.
 * 3. Se carga el tenant y se verifica que pueda atender (activo).
 */
export class ResolveTenantUseCase {
  private readonly central: ReadonlySet<string>;

  constructor(
    private readonly resolver: TenantResolver,
    private readonly tenants: TenantReader,
    private readonly domains: DomainReader,
    readonly centralDomains: readonly string[],
  ) {
    this.central = new Set(centralDomains);
  }

  async execute(request: RequestLike): Promise<Resolution> {
    const host = hostnameOf(request.host);
    if (host !== undefined && this.central.has(host)) return { kind: 'central' };

    const id = await this.resolver.resolve(request, {
      domains: this.domains,
      centralDomains: this.centralDomains,
    });
    if (!id) return { kind: 'unidentified' };

    const tenant = await requireTenant(this.tenants, id);
    assertTenantAccessible(tenant);
    return { kind: 'tenant', tenant };
  }
}
