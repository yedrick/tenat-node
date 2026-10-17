# ADR 0018 — Planes y marca de la plataforma editables desde el panel

- **Estado:** aceptada
- **Fecha:** 2026-10-18

## Contexto

En 0.11 los planes (precios, módulos, límites) solo se cambiaban en el código y había que
desplegar. La marca de la plataforma (logo, contacto) vivía en variables de entorno de cada app.

## Decisiones

1. **La configuración sigue siendo la base; el panel guarda diferencias.** `tenancy_plan_settings`
   tiene un JSON por plan con los campos cambiados (o el plan completo si se creó en el panel). Los
   planes efectivos son configuración ⊕ cambios. "Restablecer" borra los cambios de un plan de código.
2. **El catálogo de módulos no se edita desde el panel**: la app los hace cumplir con
   `requireFeature`; un módulo inventado en el panel no protegería nada.
3. **Los permisos siguen siendo síncronos.** El catálogo efectivo vive en memoria: se carga una vez
   (la primera petición la espera), se recarga al recibir `{ kind: 'plans' }` por el bus de
   invalidación y cada `refreshMs` (60 s) como respaldo si un aviso se pierde. Si la tabla no existe
   todavía (antes de `tenancy install`), se usa la configuración de código y se avisa una vez.
4. **Los planes del panel se archivan, no se borran,** y no se pueden archivar si los usan tenants o
   si son el plan por defecto: un tenant nunca queda apuntando a un plan desaparecido.
5. **Marca de la plataforma** como clave → JSON en `tenancy_platform_settings`, con valores por
   defecto en la configuración. La parte pública (`GET /tenancy/platform`) nunca incluye los correos
   internos (`salesNotifyTo`). Los archivos van al almacenamiento central bajo `platform/` y solo esa
   carpeta se sirve públicamente.
