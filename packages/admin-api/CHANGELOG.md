# @tenancy-node/admin-api

## 0.12.0

### Minor Changes

- Planes y marca de la plataforma editables desde el panel, sin desplegar:

  - `core`: `tenancy.plans.update/create/remove/describe/reload` (cambios guardados sobre la configuración; el catálogo de módulos sigue en el código), validación (`TENANCY_INVALID_PLAN`, `TENANCY_PLAN_NOT_FOUND`, `TENANCY_PLAN_CONFLICT`), recarga entre instancias por el bus de invalidación y cada 60 s (`planSettings.refreshMs`), evento `plan.updated`. Marca de la plataforma: `tenancy.platform` (`get`, `public`, `update`, `upload`), `platform.defaults` en la configuración, rutas públicas `GET /tenancy/platform` y `/tenancy/platform/assets/*` (`http.platform`), evento `platform.updated`.
  - `db`: tablas `tenancy_plan_settings` y `tenancy_platform_settings` (migración `2026_10_18_000002_plan_and_platform_settings`).
  - `admin-api`: `POST /plans`, `PATCH /plans/:id`, `DELETE /plans/:id`, `GET/PATCH /platform`, `PUT /platform/logo` y `/platform/favicon`; permisos `plans:write` y `platform:write`; `lead.created` trae `notifyTo` (los correos de ventas de la plataforma).
  - `admin-ui`: edición y creación de planes, restablecer y archivar, y página "Plataforma".
  - `cli`: `tenancy plans` incluye los planes editados o creados desde el panel.
  - `cache-redis`: la invalidación entre instancias acepta los avisos `plans` y `platform`.
  - `testing`: contrato `settingsRepositoryContract`.

### Patch Changes

- Updated dependencies
  - @tenancy-node/core@0.12.0
  - @tenancy-node/db@0.12.0
  - @tenancy-node/admin-ui@0.12.0

## 0.11.1

### Patch Changes

- Correcciones de la revisión de IONIX sobre la 0.11:

  - `core`: un tenant con un plan que ya no está en la configuración usa `defaultPlan` (antes quedaba sin módulos y sin límites); `ResolvedFeatures.unknownPlan` dice cuál era. `/tenancy/me` devuelve el plan efectivo (con `defaultPlan`) en `plan`.
  - `core`: las fuentes de `theme.fonts` se buscan sin distinguir mayúsculas y se guardan con el nombre de la lista (`arial` → `Arial`); la fuente solo se valida si cambia, así un tema guardado antes de la lista se puede seguir editando.
  - `core` + `db`: un pago de pasarela (`provider` + `providerRef`) se registra una sola vez aunque el webhook llegue repetido y en paralelo (índice único, migración `2026_10_18_000001_billing_payments_unique`; `BillingRepository.insertPayment` devuelve `false` si ya existía), y lo pagado se recalcula desde la suma de los pagos (dos pagos en paralelo no se pisan).
  - `admin-api`: el límite del formulario público de solicitudes cuenta solo los envíos válidos (y los del campo trampa): corregir un campo no gasta intentos.
  - `admin-ui`: la fuente actual se reconoce sin distinguir mayúsculas y el aviso de plan desconocido explica que se usa el plan por defecto.

- Updated dependencies
  - @tenancy-node/core@0.11.1
  - @tenancy-node/db@0.11.1
  - @tenancy-node/admin-ui@0.11.1

## 0.11.0

### Minor Changes

- Planes y módulos por tenant, avisos con push, cobros, solicitudes de la web comercial y tipografías:

  - `core`: configuración `features`, `plans` y `defaultPlan`; `tenancy.features` (`has`, `require`, `list`, `limit`, `remaining`, `assertLimit`, `of`, `catalog`) y `tenancy.plans` (`list`, `get`, `assign`). Módulos sueltos por tenant (`features: { add, remove, limits }`), errores `TENANCY_FEATURE_NOT_IN_PLAN` y `TENANCY_PLAN_LIMIT_REACHED` (403, con `details`), evento `tenant.plan_changed`, `/tenancy/me` con `planLabel`, `features` y `limits`, ruta pública `GET /tenancy/plans` y filtro `plan` en `tenants.list`. Tipografías permitidas con `theme.fonts`: se validan y `theme.css` trae su `@import`.
  - `db`: migración `2026_10_17_000001_plans_leads_notifications` (columna `features` en `tenancy_tenants` y tabla `tenancy_leads`). **Corre `tenancy install` antes de desplegar.**
  - `adapter-express`, `adapter-fastify`: `requireFeature(tenancy, ...modulos)`. Los tres adaptadores atienden `/tenancy/plans` en cualquier host.
  - `admin-api`: `GET /plans`, `GET /fonts`, `GET/PATCH/DELETE /leads`, formulario público `POST /leads` (opción `leads`: límite por IP, consentimiento, campo trampa) con el evento `lead.created`, `admin.leads.create()`, plan y módulos sueltos en `POST`/`PATCH /tenants`, `?plan=` en la lista, plan efectivo en el detalle, tenants por plan y solicitudes en `/metrics`. Permisos `leads:read` y `leads:write`.
  - `admin-ui`: páginas Planes y Solicitudes (con "Crear tenant" desde una solicitud), plan y módulos sueltos en cada tenant, lista de fuentes con vista previa, vista previa del tema y tenants por plan en el dashboard.
  - `cli`: `tenancy plans`, `tenancy tenant:plan` y `tenancy list --plan`.
  - `core`: avisos a los tenants (`tenancy.notifications`: a todos, a algunos o por plan, con roles, vigencia, lecturas por usuario, dispositivos y canales de entrega; eventos `notification.sent` y `notification.delivered`; ruta opcional `GET /tenancy/notifications`) y cobros (`tenancy.billing`: suscripción, facturas, pagos manuales y parciales, pasarelas con `PaymentProvider`, webhooks idempotentes y ciclo de cobro con suspensión opcional; eventos `billing.*`).
  - `db`: tablas de avisos, lecturas, dispositivos, suscripciones, facturas y pagos (migraciones `2026_10_17_000001` y `2026_10_17_000002`).
  - `notify-firebase` (nuevo): canal de Firebase Cloud Messaging (API HTTP v1, sin SDK), `firebase()` y `firebaseFromEnv()`.
  - `admin-api` + `admin-ui`: páginas Avisos y Cobros, cobros en el detalle del tenant, webhook `POST /billing/webhooks/:provider`; permisos `notifications:send`, `billing:read` y `billing:write`.
  - `cli`: `tenancy notify` y `tenancy billing:run`.
  - `testing`: contratos `notificationRepositoryContract` y `billingRepositoryContract`.

### Patch Changes

- Updated dependencies
  - @tenancy-node/core@0.11.0
  - @tenancy-node/db@0.11.0
  - @tenancy-node/admin-ui@0.11.0

## 0.10.0

### Minor Changes

- f52ec25: Panel más completo y con diseño nuevo:

  - `admin-api`: opción `tenantUsers` para listar y crear los usuarios de la app en cada tenant (`GET`/`POST /tenants/:id/users`), con auditoría sin contraseñas y solo los campos conocidos en la respuesta.
  - `admin-ui`: pestaña "Usuarios" en cada tenant (buscar, crear con contraseña generada, "Entrar como"), botón "Entrar" de un clic en la lista y en el detalle, rediseño completo (navegación con íconos, buscador rápido, modo oscuro, estados en castellano, menú en celulares) y diálogos que mantienen el foco al escribir.

### Patch Changes

- Updated dependencies [f52ec25]
  - @tenancy-node/admin-ui@0.10.0

## 0.9.0

### Minor Changes

- 132acef: Correcciones del reporte de integración de Dental-3D:

  - `db-mysql`, `db-postgres`, `db-sqlite`: `destroy()` cierra el pool nativo aunque Kysely nunca lo haya usado. Una app que solo usaba `tenancy.pool()` dejaba conexiones abiertas (hasta `max_connections`) y los scripts no terminaban después de `tenancy.close()`.
  - `admin-api`: opciones `trustProxy` y `clientIp`. Detrás de nginx, el límite de intentos de login bloqueaba a todos y la auditoría guardaba la IP del proxy.
  - `admin-api` + `admin-ui`: el editor de tema parte del tema efectivo (`theme.defaults` de la app) y no de `#2563EB`; la vista previa usa el dominio real del tenant.
  - `admin-api` + `admin-ui`: subir el logo (`PUT /tenants/:id/theme/logo`, PNG/JPEG/GIF/WebP por contenido, sin SVG) al almacenamiento del tenant.
  - `admin-api` + `admin-ui`: `tenantFields` y editor de `tenant.data` en "Nuevo tenant" y en el detalle; `PATCH /tenants/:id` acepta `removeData`.
  - `admin-ui`: vaciar un campo del tema y guardar ahora lo borra.
  - `core`: `tenancy.theme()` ve el tema nuevo en la misma petición después de `theme.update`/`reset`.
  - `storage-s3`: `storageFromEnv()` elige el almacenamiento (`local`, `s3` o `r2`) y lo configura desde variables de entorno, con errores claros al arrancar.

### Patch Changes

- Updated dependencies [132acef]
  - @tenancy-node/admin-ui@0.9.0
  - @tenancy-node/core@0.9.0
  - @tenancy-node/db@0.9.0
