import type { Tenant } from './domain/index.js';
import type { Observer } from './observability/observer.js';
import type {
  Bootstrapper,
  Clock,
  DomainRepository,
  EventBus,
  EventSink,
  EventTransport,
  IdGenerator,
  Logger,
  ProvisioningPipeline,
  TenantRepository,
} from './ports/index.js';
import type { Tenancy } from './tenancy.js';

/** Lo que un plugin recibe para conectarse al núcleo. */
export interface PluginSetupContext {
  /** Logger con `tenantId` automático. */
  readonly logger: Logger;
  /** Para registrar operaciones y errores con el formato estándar (ADR 0005). */
  readonly observer: Observer;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events: EventBus;
  readonly centralDomains: readonly string[];
  currentTenant(): Tenant | undefined;
}

/** Piezas que un plugin aporta al composition root. */
export interface PluginContribution {
  tenants?: TenantRepository;
  domains?: DomainRepository;
  provisioning?: ProvisioningPipeline;
  bootstrappers?: readonly Bootstrapper[];
  /** Transportes de eventos (webhook, RabbitMQ...) que `tenancy.events.forward` puede usar. */
  transports?: readonly EventTransport[];
  /** Destino durable de los eventos reenviados (outbox). Solo uno. */
  eventSink?: EventSink;
  /** Chequeos para `tenancy.health()` (por ejemplo, la base central). */
  healthChecks?: readonly { name: string; check(): Promise<void> }[];
  /** Se llama en `tenancy.close()`. */
  close?(): Promise<void>;
}

/**
 * Extiende `tenancy` sin tocar el núcleo (abierto/cerrado). Por ejemplo `@tenancy-node/db`
 * aporta repositorios SQL, el aprovisionamiento y los métodos `db()`, `centralDb()` y `sql`.
 */
export interface TenancyPlugin<TExtension extends object = object> {
  readonly name: string;
  setup(context: PluginSetupContext): PluginContribution;
  /** Métodos que se agregan al objeto `tenancy`. */
  extend?(tenancy: Tenancy): TExtension;
}

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;
type ExtensionOf<P> = P extends TenancyPlugin<infer E> ? E : never;

/** Métodos que agregan los plugins de la configuración. */
export type PluginExtensions<P extends readonly TenancyPlugin[]> = UnionToIntersection<
  ExtensionOf<P[number]>
>;
