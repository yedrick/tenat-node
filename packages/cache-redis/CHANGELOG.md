# @tenancy-node/cache-redis

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

## 0.11.1

### Patch Changes

- Updated dependencies
  - @tenancy-node/core@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies
  - @tenancy-node/core@0.11.0

## 0.9.0

### Patch Changes

- Updated dependencies [132acef]
  - @tenancy-node/core@0.9.0
