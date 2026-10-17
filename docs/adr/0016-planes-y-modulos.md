# ADR 0016 — Planes y módulos por tenant

- **Estado:** aceptada
- **Fecha:** 2026-10-17

## Contexto

Las apps SaaS sobre tenancy-node venden planes: cada tenant ve solo los módulos que paga y tiene
límites (usuarios, sucursales). Hasta 0.10 el tenant solo tenía un campo `plan` de texto libre, y
cada app repetía la lógica en la API, el menú y la web de precios, que terminaban contradiciéndose.

## Decisiones

1. **Una sola fuente: la configuración.** `features` (catálogo), `plans` (módulos, límites,
   precio, `public`) y `defaultPlan` viven en `createTenancy`. De ahí salen `tenancy.features`,
   `requireFeature`, `/tenancy/me`, `GET /tenancy/plans`, el panel y la CLI. Los planes no se
   guardan en la base: cambiarlos es un despliegue, versionado con el código.
2. **La librería no conoce módulos concretos.** Los nombres los pone cada proyecto. El
   autocompletado es opcional, con declaration merging (`TenancyFeatureMap`, `TenancyLimitMap`),
   igual que `TenancyEventMap`.
3. **Módulos sueltos por tenant en la base central** (columna `features`: `{ add, remove, limits }`),
   para vender "Básico + Reportes" sin crear un plan. Se normalizan (sin repetidos, ordenados) y se
   validan contra el catálogo al escribir.
4. **Los datos nunca se borran por el plan.** Bajar de plan oculta y bloquea; los límites solo
   impiden crear más (`assertLimit` con el total que cuenta la app, porque la librería no conoce
   sus tablas).
5. **Tolerante al leer, estricto al escribir.** Asignar un plan que no existe es un error (422).
   Leer un tenant con un plan que ya no está en la configuración no rompe: queda sin módulos de plan
   y se avisa una vez en el log.
6. **Sin `plans` el control está apagado** (todo permitido), así 0.11 se instala sin cambiar
   comportamiento, y `publicFields` sigue leyendo `features`/`limits` de `tenant.data` como antes.
7. **Errores 403 con detalles públicos.** `TENANCY_FEATURE_NOT_IN_PLAN` y
   `TENANCY_PLAN_LIMIT_REACHED` son los únicos errores que incluyen `details` en la respuesta HTTP,
   para que el frontend muestre "Tu plan permite 3 usuarios".
8. **`GET /tenancy/plans` es público** (cualquier host, CORS abierto, ETag): lo consume la web
   comercial, que vive en el dominio central o en otro sitio.
9. **Solicitudes de demo en el panel**, no en el núcleo: necesitan base central, límite por IP y
   gestión con roles. La ruta pública `POST /admin/api/leads` está apagada por defecto, usa un campo
   trampa (responde 201 sin guardar) y publica `lead.created` para que la app avise por su canal.
10. **Tipografías permitidas** (`theme.fonts`): con lista, el tema solo acepta esas familias y
    `theme.css` incluye el `@import` de Google Fonts o de la URL propia; sin lista, nada cambia.

## Consecuencias

- Al actualizar desde 0.10 hay que correr `tenancy install` antes de desplegar (columna nueva).
- `/tenancy/me` se cachea (`http.cacheControl`, 5 min por defecto): un cambio de plan llega al
  navegador al vencer la caché; la API lo aplica de inmediato.
- Cambiar precios exige desplegar. Si hace falta editarlos desde el panel, se puede agregar una
  capa en la base sin romper esta API.
