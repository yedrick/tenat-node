# ADR 0005 — Observabilidad desde el núcleo

- **Estado:** aceptada
- **Fecha:** 2026-09-25

## Contexto

Con cientos o miles de tenants, "algo falló" no sirve: hay que saber **en qué tenant**, **en qué operación** y **por qué**, y poder ver los errores de un tenant concreto. Esto no puede esperar a la fase de OpenTelemetry: tiene que ser parte del núcleo desde el inicio.

## Decisión

1. **Logs estructurados con campos fijos.** Toda línea que escribe el paquete usa los mismos nombres:

   | campo                                               | contenido                                                                                                           |
   | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
   | `tenantId`                                          | id del tenant o `null` (central). Siempre presente.                                                                 |
   | `operation`                                         | `tenants.create`, `domains.add`, `http.request`, `events.listener`, `tenancy.resolve`, `tenancy.runForEach.item`... |
   | `outcome`                                           | `success` o `error`                                                                                                 |
   | `durationMs`                                        | duración de la operación o de la petición                                                                           |
   | `code`                                              | código estable del error (`TENANCY_*`, `ECONNREFUSED`, nombre de la clase)                                          |
   | `errorId`                                           | id del error en el `ErrorTracker` (para cruzar log y panel)                                                         |
   | `requestId`, `method`, `path`, `host`, `statusCode` | en peticiones HTTP                                                                                                  |
   | `err`                                               | el error completo con stack                                                                                         |

2. **Niveles:** escrituras correctas en `info`, lecturas en `debug`, errores del cliente (4xx) en `warn`, errores del servidor (5xx) en `error`.
3. **`tenantId` automático:** el logger del paquete (`ContextualLogger`) toma el tenant de `AsyncLocalStorage`. `tenancy.observability.logger` está disponible para la aplicación.
4. **Un error se asigna al tenant del que habla:** si un error del paquete trae `details.tenantId` (tenant suspendido, no encontrado...), se registra bajo ese tenant aunque la petición no haya entrado a su contexto.
5. **Registro de errores por tenant (`ErrorTracker`):** puerto con implementación en memoria (ring buffer por tenant). `tenancy.observability.errors({ tenantId })` y `summary()` los exponen para el CLI, el panel admin y health checks.
6. **Ningún error se pierde en silencio:** listeners `async`, reverts de bootstrappers, errores de handlers HTTP y fallos de `runForEach` pasan por el mismo `Observer`.
7. El logger es compatible con **pino** (`logger: pino()`).

## Consecuencias

- Filtrar por tenant es un `grep '"tenantId":"bolivar"'` o una consulta en Loki/Datadog/ELK.
- En varias instancias, el `ErrorTracker` en memoria es por proceso; en fases siguientes se agrega un tracker persistente (base central / Redis) detrás del mismo puerto.
- Los spans de OpenTelemetry (Fase 8) usarán los mismos nombres de `operation`.
