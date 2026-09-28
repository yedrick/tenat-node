/**
 * Evento de dominio: algo que ya ocurrió. El `EventBus` lo envuelve en un
 * sobre con `id` (ULID) y `time` antes de entregarlo a los listeners.
 */
export interface DomainEvent<TType extends string = string, TData = unknown> {
  readonly type: TType;
  readonly data: TData;
  /** Tenant al que pertenece. `undefined` = tomarlo del contexto actual. `null` = central. */
  readonly tenantId?: string | null;
}
