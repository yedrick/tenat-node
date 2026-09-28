/** Un error registrado, con todo el contexto para diagnosticarlo. */
export interface TrackedError {
  /** ULID del registro; también va en el log (`errorId`) para cruzarlos. */
  readonly id: string;
  /** `null` = contexto central. */
  readonly tenantId: string | null;
  /** Operación donde ocurrió: 'tenants.create', 'http.request', 'events.listener'... */
  readonly operation: string;
  /** Código estable (`TENANCY_*`) o el nombre del error si no es del paquete. */
  readonly code: string;
  readonly name: string;
  readonly message: string;
  readonly stack: string | undefined;
  readonly time: Date;
  /** Datos adicionales: método y ruta HTTP, tipo de evento, id de la petición... */
  readonly context: Readonly<Record<string, unknown>>;
}

export interface ErrorSummary {
  readonly tenantId: string | null;
  readonly total: number;
  readonly byCode: Readonly<Record<string, number>>;
  readonly lastErrorAt: Date | null;
}

/** Guarda los errores recientes por tenant para consultarlos (CLI, panel admin, health). */
export interface ErrorTracker {
  record(error: TrackedError): void;
  /** Errores más recientes primero. `tenantId` `null` = central; `undefined` = todos. */
  recent(options?: { tenantId?: string | null; limit?: number }): TrackedError[];
  summary(): ErrorSummary[];
  clear(tenantId?: string | null): void;
}
