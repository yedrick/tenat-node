# ADR 0001 — Arquitectura hexagonal (puertos y adaptadores)

- **Estado:** aceptada
- **Fecha:** 2026-09-25

## Contexto

El paquete debe soportar varios motores de base de datos, caché, almacenamiento, colas y frameworks HTTP. Si la lógica de negocio conoce la infraestructura, cada motor nuevo obliga a tocar el núcleo.

## Decisión

Se usa arquitectura hexagonal con cuatro zonas dentro de `@tenancy-node/core`:

- `domain/`: entidades, value objects, eventos y errores. Sin dependencias externas.
- `ports/`: interfaces que el núcleo necesita (`TenantRepository`, `CacheStore`, `EventBus`, ...).
- `application/`: casos de uso; dependen solo de `domain/` y `ports/`.
- Infraestructura y presentación (resto de `core/src` y los demás paquetes): implementan puertos o llaman casos de uso.

La regla se verifica con `dependency-cruiser` (`pnpm depcruise`) en el CI.

## Consecuencias

- Agregar un motor o transporte es crear un paquete nuevo que implementa un puerto.
- Cada puerto tiene una suite de contrato en `@tenancy-node/testing` que toda implementación debe pasar.
- Hay algo más de código "de pegamento" (el composition root), a cambio de un núcleo testeable sin infraestructura.
