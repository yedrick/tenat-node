/** Qué cambió. `all` vacía todo (por ejemplo tras una restauración de la base central). */
export type Invalidation =
  | { readonly kind: 'tenant'; readonly tenantId: string }
  | { readonly kind: 'domain'; readonly domain: string }
  | { readonly kind: 'domains-of'; readonly tenantId: string }
  | { readonly kind: 'all' };

export interface InvalidationMessage {
  /** Id de la instancia que publicó (cada una ignora sus propios mensajes). */
  readonly origin: string;
  readonly items: readonly Invalidation[];
}

/**
 * Avisa a las demás instancias de la app que un tenant o dominio cambió, para que borren
 * su caché de búsqueda en el acto (sin esperar el TTL). Entrega "a lo sumo una vez":
 * si un mensaje se pierde, el TTL de la caché sigue poniendo el límite.
 */
export interface InvalidationBus {
  publish(message: InvalidationMessage): Promise<void>;
  subscribe(handler: (message: InvalidationMessage) => void): Promise<void>;
  ping?(): Promise<void>;
  close(): Promise<void>;
}
