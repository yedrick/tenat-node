# Rendimiento

Tres mediciones, todas reproducibles con los scripts de [`bench/`](https://github.com/yedrick/tenat-node/tree/main/bench). Miden el código compilado que se publica (`dist`), no el fuente.

**Equipo:** Intel Core i5-10400F (6 núcleos, 12 hilos), 47 GB de RAM, Linux, Node.js 20.20. Los números solo sirven para comparar entre corridas en el mismo equipo. En producción importan la red, tu base y tu código.

## Prueba de carga: 10 000 tenants

```sh
pnpm --filter tenancy-node-bench load    # LOAD_TENANTS=10000 LOAD_SECONDS=30
```

La prueba corre sobre PostgreSQL 16 en Docker, en la misma máquina. Todos los tenants están en una base (`isolation: 'schema'`), con credenciales compartidas y un pool de 20 conexiones. La corrida tiene tres partes:

1. **Creación:** 10 000 tenants, 16 en paralelo. Cada uno recibe su schema, su migración y su seed.
2. **Carga HTTP:** 100 conexiones durante 30 s contra `node:http` + `withTenancy`. Cada petición va a un tenant al azar entre los 10 000 y hace una consulta a su schema.
3. **Verificación:** cada respuesta trae el tenant del contexto y el dato leído de su schema, y la prueba confirma que coinciden con el `Host` de la petición.

| Fase                                      | Resultado                                     |
| ----------------------------------------- | --------------------------------------------- |
| Crear 10 000 tenants                      | **54,7 s** (≈183 por segundo), p50 82 ms, p99 154 ms por tenant |
| HTTP con la caché de búsqueda             | **4 551 req/s**, p50 20 ms, p99 48 ms         |
| HTTP sin la caché de búsqueda             | 2 027 req/s, p50 46 ms, p99 82 ms             |
| Respuestas con el tenant equivocado       | **0** de 197 337 verificadas                  |
| Errores                                   | 0                                             |
| Memoria del servidor                      | 365 MB de RSS (221 MB de heap)                |

La caché de búsqueda (`lookupCache`) duplica el rendimiento cuando los tenants viven en la base central: sin ella, cada petición consulta el dominio y el tenant.

::: info Lo que encontró esta prueba
La primera corrida creaba ~5 tenants por segundo, cada vez más lento. El `Migrator` de Kysely lista **todas** las tablas de **todos** los schemas para saber si existe su tabla de control. Con miles de tenants en modo schema, crear o migrar N tenants costaba O(N²).

Desde 0.8.0, el migrador, el explorador del panel y `tenancy move` leen solo el schema del tenant. Con ese cambio se crean los 10 000 tenants en 55 s.
:::

## Costo por petición en HTTP

```sh
pnpm --filter tenancy-node-bench http
```

La prueba compara el mismo endpoint (responde el id del tenant) con y sin tenancy. Reparte las peticiones entre 1 000 tenants en memoria. Usa autocannon con 50 conexiones durante 10 s, y el servidor corre en otro proceso.

| Servidor                                         | req/s  | p50  | p99  |
| ------------------------------------------------ | ------ | ---- | ---- |
| `node:http` sin tenancy                          | 23 240 | 1 ms | 4 ms |
| `node:http` + `withTenancy`                      | 14 331 | 3 ms | 7 ms |
| `node:http` + `withTenancy` (sin log por petición) | 17 303 | 2 ms | 6 ms |
| Fastify sin tenancy                              | 23 243 | 1 ms | 4 ms |
| Fastify + `tenancyPlugin`                        | 12 485 | 3 ms | 7 ms |
| Fastify + `tenancyPlugin` (sin log por petición) | 14 266 | 3 ms | 7 ms |

Tenancy agrega entre **27 y 37 µs por petición**, según el adaptador. Eso incluye identificar el tenant, abrir y cerrar su contexto, y escribir la línea de log con su `tenantId`. En un endpoint vacío se nota. En uno que consulta una base (cientos de microsegundos o más) es poco: en la prueba de carga de arriba, el cuello de botella es PostgreSQL.

Si no necesitas una línea por petición, `logRequests: false` ahorra unos 12 µs. Los errores se siguen registrando con su tenant.

## Micro-benchmarks del núcleo

```sh
pnpm --filter tenancy-node-bench micro
```

Todo en memoria, con 1 000 tenants y tinybench:

| Operación                                        | ops/s     | media   | p99      |
| ------------------------------------------------ | --------- | ------- | -------- |
| Referencia: `AsyncLocalStorage.run` + `await`    | 1 260 446 | 0,9 µs  | 1,6 µs   |
| `resolve()` por dominio                          | 162 389   | 6,7 µs  | 13,4 µs  |
| Una petición: `openRequestScope` + `run` + `close` | 97 926  | 11,3 µs | 21,2 µs  |
| `tenancy.run(id)`                                | 148 005   | 7,5 µs  | 14,4 µs  |
| `tenancy.cache().get()` (memoria)                | 123 713   | 8,9 µs  | 17,9 µs  |
| `tenancy.theme().toCss()` (cacheado)             | 119 701   | 9,2 µs  | 17,7 µs  |

Con repositorios en memoria, la caché de búsqueda no acelera `resolve()`, porque el repositorio ya es un `Map`. Su valor aparece frente a una base de datos, como muestra la prueba de carga.

Los resultados completos, con los datos del equipo, quedan en `bench/results/*.json`.
