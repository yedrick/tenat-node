# ADR 0003 — AsyncLocalStorage para el contexto del tenant

- **Estado:** aceptada
- **Fecha:** 2026-09-25

## Contexto

Cada petición, job o script debe saber cuál es el tenant actual sin pasarlo como parámetro por toda la aplicación, y sin variables globales que se mezclen entre peticiones concurrentes.

## Decisión

Se usa `AsyncLocalStorage` de `node:async_hooks`. `TenancyContext.run(tenant, fn)` abre un contexto; todo el código asíncrono que se ejecute dentro lo hereda. No se usa `enterWith` en ningún adaptador: cambia el contexto de todo lo que sigue en la ejecución actual y, si algo lo llama fuera del lugar previsto, el tenant se filtra a la siguiente petición.

Express y `node:http` envuelven el resto de la cadena en un único callback (`scope.run(() => next())` o `scope.run(() => handler(req, res))`).

Fastify no tiene un callback así: su ciclo es una serie de hooks. El adaptador resuelve el tenant en `onRequest` y llama a `scope.run(() => next())`, así que los hooks y el handler que Fastify ejecuta de forma síncrona desde ese `next` heredan el contexto. Pero leer el body usa eventos del stream (`data`, `end`), y esos callbacks corren en el contexto asíncrono de la petición HTTP, no en el del tenant. Por eso, al abrir el contexto, el adaptador también guarda un `AsyncResource` (`scope.bind()`) y lo restaura con `runInAsyncScope` en `preValidation` y `preHandler`, los hooks que corren después del parseo del body. Así el handler y la validación siempre ven al tenant, aunque haya un body de por medio. El contexto se cierra en `onResponse` (o `onRequestAbort`).

## Consecuencias

- Sin dependencias y con soporte nativo de `await`.
- Librerías que usan colas de callbacks propias pueden perder el contexto; se documenta y se ofrece `tenancy.run()` manual.
- Los tests de aislamiento concurrente son obligatorios en el CI (incluyen peticiones con body en Fastify y Express).
- En Express el contexto no se restaura después del body: `tenancyMiddleware` va después de los body parsers.
- En Fastify, un parser de body propio (`addContentTypeParser`) que lee el stream puede correr sin el contexto del tenant; desde `preValidation` en adelante el contexto siempre está.
