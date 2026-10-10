# @tenancy-node/admin-ui

## 0.10.0

### Minor Changes

- f52ec25: Panel más completo y con diseño nuevo:

  - `admin-api`: opción `tenantUsers` para listar y crear los usuarios de la app en cada tenant (`GET`/`POST /tenants/:id/users`), con auditoría sin contraseñas y solo los campos conocidos en la respuesta.
  - `admin-ui`: pestaña "Usuarios" en cada tenant (buscar, crear con contraseña generada, "Entrar como"), botón "Entrar" de un clic en la lista y en el detalle, rediseño completo (navegación con íconos, buscador rápido, modo oscuro, estados en castellano, menú en celulares) y diálogos que mantienen el foco al escribir.

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
