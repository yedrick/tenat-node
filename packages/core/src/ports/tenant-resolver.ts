import type { TenantId } from '../domain/index.js';
import type { DomainReader } from './domain-repository.js';

/** Petición neutral: cada adaptador (Fastify, Express, node:http) la construye. */
export interface RequestLike {
  /** Header Host (puede incluir el puerto). */
  host?: string | undefined;
  /** Ruta sin query string: '/bolivar/productos'. */
  path?: string | undefined;
  /** Headers con nombres en minúsculas. */
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export interface ResolveContext {
  readonly domains: DomainReader;
  /** Dominios centrales normalizados ('tuapp.com'). */
  readonly centralDomains: readonly string[];
}

/** Estrategia para identificar al tenant de una petición. */
export interface TenantResolver {
  readonly name: string;
  resolve(request: RequestLike, context: ResolveContext): Promise<TenantId | undefined>;
}
