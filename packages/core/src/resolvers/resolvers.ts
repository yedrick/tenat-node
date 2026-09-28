import { hostnameOf } from '../application/request-host.js';
import { DomainName, TenantId } from '../domain/index.js';
import type { RequestLike, ResolveContext, TenantResolver } from '../ports/index.js';

/** Busca el host completo en la tabla de dominios: 'clubbolivar.com' → bolivar. */
export function byDomain(): TenantResolver {
  return {
    name: 'domain',
    async resolve(request, context) {
      const name = DomainName.tryCreate(hostnameOf(request.host));
      if (!name) return undefined;
      const domain = await context.domains.findByName(name);
      return domain?.tenantId;
    },
  };
}

export interface SubdomainResolverOptions {
  /** Dominios base. Por defecto, los `centralDomains` de la configuración. */
  baseDomains?: readonly string[];
}

/** Toma el primer label bajo un dominio base: 'bolivar.tuapp.com' → bolivar. Solo un nivel. */
export function bySubdomain(options: SubdomainResolverOptions = {}): TenantResolver {
  const configured = options.baseDomains?.map((d) => DomainName.create(d));
  return {
    name: 'subdomain',
    async resolve(request, context) {
      const host = DomainName.tryCreate(hostnameOf(request.host));
      if (!host) return undefined;
      const bases = configured ?? toDomainNames(context.centralDomains);
      for (const base of bases) {
        if (host.value.length > base.value.length && host.isWithin(base)) {
          const sub = host.value.slice(0, -(base.value.length + 1));
          if (!sub.includes('.')) return TenantId.tryCreate(sub);
        }
      }
      return undefined;
    },
  };
}

export interface PathResolverOptions {
  /** Posición del segmento de la ruta que contiene el id. Por defecto 0: '/bolivar/productos'. */
  segment?: number;
}

export function byPath(options: PathResolverOptions = {}): TenantResolver {
  const segment = options.segment ?? 0;
  return {
    name: 'path',
    async resolve(request) {
      const parts = (request.path ?? '').split('?', 1)[0]!.split('/').filter(Boolean);
      return TenantId.tryCreate(parts[segment]);
    },
  };
}

/** Lee el id de un header: 'X-Tenant: bolivar'. Útil para APIs y apps móviles. */
export function byHeader(header = 'x-tenant'): TenantResolver {
  const name = header.toLowerCase();
  return {
    name: 'header',
    async resolve(request) {
      const value = request.headers[name];
      return TenantId.tryCreate(Array.isArray(value) ? value[0] : (value as string | undefined));
    },
  };
}

/** Prueba varios resolvers en orden y se queda con el primero que encuentre un tenant. */
export function chain(resolvers: readonly TenantResolver[]): TenantResolver {
  return {
    name: `chain(${resolvers.map((r) => r.name).join(',')})`,
    async resolve(request: RequestLike, context: ResolveContext) {
      for (const resolver of resolvers) {
        const id = await resolver.resolve(request, context);
        if (id) return id;
      }
      return undefined;
    },
  };
}

export type ResolverName = 'domain' | 'subdomain' | 'path' | 'header';

export function resolverFromName(name: ResolverName): TenantResolver {
  switch (name) {
    case 'domain':
      return byDomain();
    case 'subdomain':
      return bySubdomain();
    case 'path':
      return byPath();
    case 'header':
      return byHeader();
  }
}

function toDomainNames(values: readonly string[]): DomainName[] {
  return values.flatMap((value) => {
    const name = DomainName.tryCreate(value);
    return name ? [name] : [];
  });
}
