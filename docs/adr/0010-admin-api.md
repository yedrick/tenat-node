# ADR 0010 — Admin API

- **Estado:** aceptada
- **Fecha:** 2026-09-25

## Contexto

El panel da acceso a todos los tenants: es la superficie más sensible del paquete. Tiene que poder montarse en la app o correr aparte, y la UI (Fase 7) solo consume esta API.

## Decisiones

1. **Sin framework.** Un router propio sobre `node:http`: la misma API se monta en Express (`adminMiddleware`), Fastify (`registerAdminFastify`, en `onRequest`) o su propio proceso (`serveAdmin` / `tenancy admin:serve`, por defecto en `127.0.0.1`).
2. **Una definición por ruta** (método, ruta, permiso, esquema Valibot, resumen): de ahí salen la validación, la verificación de permisos y el documento **OpenAPI 3.1** (`/openapi.json`).
3. **Autenticación.** Contraseñas con argon2id (parámetros OWASP; mínimo 12 caracteres). Sesiones de 8 h: el token (32 bytes) va en una cookie `HttpOnly; SameSite=Strict; Secure` o como `Authorization: Bearer` para automatizar; en la base solo queda su SHA-256. Con cookie, toda petición que cambia algo exige `X-CSRF-Token` (HMAC de la sesión). Límite de intentos por IP y por email; el login responde lo mismo, y tarda lo mismo, si el email no existe. 2FA TOTP (RFC 6238) opcional. Cambiar la contraseña, cambiar el rol o desactivar a un usuario cierra sus sesiones.
4. **Roles** `support` (ver, vaciar caché, impersonar) < `admin` (cambiar tenants, dominios, tema, migraciones, webhooks, reintentar eventos, auditoría) < `owner` (borrar tenants, usuarios). Siempre queda al menos un owner activo.
5. **Auditoría** de cada acción (con `before`/`after`, IP y usuario), incluidos los logins fallidos y cada lectura del explorador de datos. Nunca se guardan contraseñas ni tokens.
6. **Solo dominios centrales.** Una petición con el host de un tenant recibe 404.
7. **Progreso en vivo (SSE)** leyendo `tenancy_provisioning_steps` de la base: funciona aunque el tenant se cree en otro proceso.
8. **Explorador de datos de solo lectura.** Tablas y columnas se validan contra la estructura real; valores parametrizados; columnas sensibles (`password`, `secret`, `token`, `hash`...) ocultas y no filtrables; máximo 100 filas por página.
9. **Impersonación** con tokens de un solo uso (60 s por defecto), guardados como hash y válidos solo en su tenant; la app los canjea con `consumeImpersonationToken`.
10. **HTTP endurecido:** body máximo de 1 MiB (413 limpio), solo JSON, headers `nosniff`, `DENY`, `no-store` y CSP restrictiva, errores internos sin detalles.

## Límites conocidos

- El límite de intentos y el registro de errores son por proceso (en memoria). Con varias réplicas del panel, cada una cuenta los suyos.
- El explorador de datos no permite editar (la edición por rol queda para después).
