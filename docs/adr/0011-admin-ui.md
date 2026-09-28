# ADR 0011 — Interfaz del panel

- **Estado:** aceptada
- **Fecha:** 2026-09-25

## Decisiones

1. **SPA React 19 + Vite + TanStack Query/Table + Tailwind 4**, compilada a archivos estáticos (≈110 KB gzip) que la Admin API sirve en `/admin` con `ui: true` (o `tenancy admin:serve --ui`). Sin servidor propio ni SSR.
2. **Solo habla por HTTP.** La regla `ui-only-talks-http` impide que la UI importe paquetes del backend: nada de lógica ni secretos del servidor en el bundle.
3. **La UI no es la barrera de seguridad.** Oculta lo que el rol no puede hacer, pero el servidor verifica cada permiso. El token CSRF vive en memoria (no en `localStorage`); la sesión, en una cookie `HttpOnly`.
4. **CSP estricta** para la UI: `script-src 'self'; style-src 'self'`, sin inline ni orígenes externos; `frame-ancestors 'none'`. Los estilos dinámicos (vista previa del tema) se aplican por CSSOM, que la CSP permite. Assets con hash cacheados para siempre; `index.html` con `no-cache`; rutas protegidas contra `../`.
5. **Sin dependencias de router ni de estado global:** un router mínimo sobre la History API y TanStack Query para el estado del servidor.
6. **Pruebas.** Componentes con jsdom + Testing Library, y un E2E en **Chromium real** (Playwright como librería dentro de Vitest) contra PostgreSQL: login, creación con progreso en vivo, tema con vista previa, dominios, explorador de datos, webhooks, usuarios, auditoría, roles y CSP sin violaciones.

## Consecuencias

- El CI instala Chromium (`playwright install --with-deps chromium`).
- La UI está en español; la internacionalización queda para después.
