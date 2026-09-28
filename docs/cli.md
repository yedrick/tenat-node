# CLI (`npx tenancy`)

El CLI lee `tenancy.config.(ts|js|mjs|cjs)` del directorio actual (o `--config`). Carga TypeScript sin compilar.
Cada comando llama a la API del paquete: lo mismo que hace el CLI lo puedes hacer desde tu código.

| Comando                                                                                                                      | Qué hace                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenancy init [--driver=mysql\|postgres\|sqlite\|mssql] [--force]`                                                           | Detecta framework, ORM, lenguaje, módulos y motor; genera `tenancy.config`, `src/tenancy`, `migrations/` y `.env.example` (con una llave nueva)                        |
| `tenancy install`                                                                                                            | Crea las tablas `tenancy_*` y corre tus migraciones centrales (idempotente)                                                                                            |
| `tenancy create <id> [--name] [--domain=a,b] [--plan] [--data=json]`                                                         | Crea y aprovisiona un tenant                                                                                                                                           |
| `tenancy create --from=tenants.csv [--concurrency=5] [--dry-run]`                                                            | Creación masiva. Columnas: `id,name,domain,plan,data` (`domain` admite varios con `\|`). Valida todo el archivo antes de crear                                         |
| `tenancy list [--status=a,b] [--search] [--page] [--per-page] [--deleted]`                                                   | Lista tenants                                                                                                                                                          |
| `tenancy delete <id> [--force]`                                                                                              | Borra base, usuario y dominios. Pide escribir el id para confirmar (fuera de una terminal exige `--force`)                                                             |
| `tenancy migrate [--tenants=a,b] [--concurrency=5]`                                                                          | Migraciones pendientes en cada tenant, con progreso por tenant                                                                                                         |
| `tenancy migrate:status <id>`                                                                                                | Migraciones ejecutadas y pendientes de un tenant                                                                                                                       |
| `tenancy rollback [--tenants] [--steps=1]`                                                                                   | Revierte migraciones                                                                                                                                                   |
| `tenancy seed [--tenants]`                                                                                                   | Corre el seed configurado                                                                                                                                              |
| `tenancy run "<comando>" [--tenants] [--concurrency=1]`                                                                      | Ejecuta un comando por tenant con `TENANCY_TENANT_ID`, `TENANCY_TENANT_NAME`, `DATABASE_URL` y `TENANCY_DATABASE_NAME`; la salida sale con prefijo `[tenant]`          |
| `tenancy servers:add <id> --host [--port] [--admin-user] [--admin-password-env=VAR] [--max-tenants] [--weight] [--inactive]` | Registra un servidor. La contraseña se lee de una variable de entorno (no queda en el historial) y se guarda cifrada                                                   |
| `tenancy servers:list`                                                                                                       | Servidores, tenants por servidor, límites y pesos                                                                                                                      |
| `tenancy key:generate`                                                                                                       | Llave nueva para `TENANCY_KEY`                                                                                                                                         |
| `tenancy key:rotate`                                                                                                         | Vuelve a cifrar todos los secretos con la llave actual                                                                                                                 |
| `tenancy move <id> --to=<servidor> [--drop-source] [--batch-size=1000] [--drain-ms=1000] [--message]`                        | Mueve la base del tenant a otro servidor: mantenimiento, copia verificada tabla por tabla y cambio de servidor. El origen se conserva salvo `--drop-source` (ADR 0015) |
| `tenancy schema --prisma\|--drizzle\|--typeorm [--out=archivo]`                                                              | Modelos de las tablas `tenancy_*` para tu ORM, leídos de la base real                                                                                                  |
| `tenancy worker [--concurrency=5] [--entry=src/jobs.ts]`                                                                     | Procesa la cola (trabajos y listeners en modo `queue`) hasta SIGINT/SIGTERM; espera los trabajos en curso al detenerse                                                 |
| `tenancy outbox:relay`                                                                                                       | Publica los eventos de la outbox y, si está el plugin de webhooks, despacha las entregas; hasta SIGINT/SIGTERM                                                         |
| `tenancy outbox:status [--tenant=id]`                                                                                        | Eventos por estado y el dead-letter (sale con código 1 si hay eventos fallidos)                                                                                        |
| `tenancy outbox:retry --id=… \| --tenant=… \| --all`                                                                         | Vuelve a poner en cola eventos del dead-letter                                                                                                                         |
| `tenancy admin:user <email> [--role=owner\|admin\|support] [--name=..] [--password-env=VAR] [--reset-password]`              | Crea un usuario del panel (si no hay contraseña, genera una y la muestra una vez) o le cambia la contraseña cerrando sus sesiones                                      |
| `tenancy admin:serve [--port=4000] [--host=127.0.0.1] [--ui] [--insecure-cookies]`                                           | Admin API en su propio proceso (con `--ui`, también la interfaz en `/admin`); el secreto sale de `TENANCY_ADMIN_SECRET`                                                |

## Opciones globales

- `--json`: salida en JSON para scripts y CI (los errores siguen yendo a stderr).
- `--log-file=tenancy.log` (o `TENANCY_LOG_FILE`): guarda **todos** los logs JSON: cada paso de aprovisionamiento, cada migración y cada error, con `tenantId`, `operation`, `code` y `durationMs` (ADR 0005).
- `--verbose`: muestra todos los logs en stderr y los stacks de los errores.
- `--config=ruta`, `--no-color`, `--help`, `--version`.

Por defecto la terminal muestra solo la salida legible y los logs de nivel `error`. Los errores de cada tenant se ven en la línea `✗ tenant CÓDIGO mensaje` y quedan completos en el log.

## Códigos de salida

| Código | Significado                                                                                   |
| ------ | --------------------------------------------------------------------------------------------- |
| `0`    | Todo bien                                                                                     |
| `1`    | La operación falló, o falló en al menos un tenant (se resume al final cuáles)                 |
| `2`    | Uso o configuración inválidos (argumentos, CSV mal formado, falta el plugin de base de datos) |

## Formas de la configuración

```ts
export default defineConfig({ ... });  // lo recomendado: el CLI crea la instancia con su logger
export default tenancy;                // una instancia ya creada (usa tu logger)
export const tenancy = createTenancy(...);
```
