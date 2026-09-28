# ADR 0004 — Inyección de dependencias manual

- **Estado:** aceptada
- **Fecha:** 2026-09-25

## Contexto

Los casos de uso reciben sus dependencias por constructor. Hace falta un lugar donde se conecten.

## Decisión

Todo se conecta en `createTenancy(config)` (composition root), sin contenedor de DI. Cada dependencia puede reemplazarse desde la configuración (`repositories`, `cache`, `logger`, `clock`, ...).

## Consecuencias

- El grafo de dependencias se lee de arriba abajo en un solo archivo.
- No hay decoradores ni metadatos de reflexión; el paquete sigue siendo liviano.
