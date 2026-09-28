# Mover tenants entre servidores

Cuando un servidor se llena o un cliente necesita uno dedicado, puedes mover la base de un tenant a otro servidor registrado. Es una copia en frío: el tenant queda en mantenimiento mientras dura, y el origen no se toca hasta que el destino está verificado ([ADR 0015](/adr/0015-mover-tenants)).

Funciona con MySQL/MariaDB y PostgreSQL. SQLite y SQL Server, todavía no.

## Antes de empezar

- El servidor de destino debe estar registrado y ser del mismo motor (MySQL y MariaDB se consideran compatibles):

  ```bash
  TENANCY_PG2_PASSWORD=... npx tenancy servers:add pg-2 --host=10.0.0.6 --admin-user=provisioner --admin-password-env=TENANCY_PG2_PASSWORD
  ```

- La contraseña del servidor se guarda cifrada: necesitas `encryptionKey` (`TENANCY_KEY`).
- Necesitas `migrations.tenant`. El destino se crea con tus migraciones y después se copian los datos. Una tabla que existe en el origen pero no la crean tus migraciones detiene el movimiento.
- El destino debe tener lugar (`maxTenants`) y estar activo.

## Desde la terminal

```bash
npx tenancy move bolivar --to=pg-2
npx tenancy move bolivar --to=pg-2 --batch-size=500 --drain-ms=5000 --message="Volvemos en 10 minutos"
npx tenancy move bolivar --to=pg-2 --drop-source
```

| Opción          | Por defecto | Qué hace                                                                   |
| --------------- | ----------- | -------------------------------------------------------------------------- |
| `--to`          | (obligatoria) | Id del servidor de destino (`tenancy servers:list`)                      |
| `--drop-source` | no          | Borra la base y el usuario del origen cuando el destino ya está verificado |
| `--batch-size`  | 1000        | Filas por lote al copiar                                                   |
| `--drain-ms`    | 1000        | Espera tras activar el mantenimiento                                       |
| `--message`     | `Moving to another database server` | Mensaje de mantenimiento que ven los usuarios      |

El CLI muestra una línea por tabla terminada y, al final, cuántas tablas y filas copió. Si no usaste `--drop-source`, te recuerda que la base vieja sigue en el origen. Con `--verbose` también ves el avance de cada lote.

## Desde código

```ts
const result = await tenancy.database.move('bolivar', {
  to: 'pg-2',
  dropSource: false, // por defecto: el origen se conserva
  batchSize: 1000,
  drainMs: 1000,
  maintenanceMessage: 'Estamos mudando tus datos, vuelve en unos minutos',
  onProgress: ({ table, copied, total }) => console.log(`${table}: ${copied}/${total}`),
});
// { tenantId, from, to, database, rows: { clientes: 250, ... }, sequencesReset, sourceDropped }
console.log(result.rows, result.sequencesReset, result.sourceDropped);
```

`onProgress` se llama después de cada lote. Una tabla vacía no genera avances, pero sí aparece en `rows` con 0.

## Qué pasa, paso a paso

1. **Candado** del tenant, el mismo del aprovisionamiento: no puede correr a la vez que un `create`, un reintento u otro `move` del mismo tenant.
2. **Validaciones**: el tenant existe, tiene base, está `active`, `maintenance` o `suspended`, no está ya en el destino, y el destino existe y es del mismo motor.
3. **Cupo**: se reserva un lugar en el destino respetando `maxTenants`.
4. **Mantenimiento**: si el tenant estaba `active`, pasa a `maintenance` con tu mensaje (las peticiones HTTP reciben 503) y se espera `drainMs` para que terminen las que estaban en curso. Si ya estaba en mantenimiento o suspendido, no cambia de estado y no hay espera.
5. **`createDatabase`**: si el destino ya tiene una base (o schema) con ese nombre, se detiene sin crear nada. Nunca pisa una base existente.
6. **`createUser`**: con `credentials: 'per-tenant'`, crea el mismo usuario con la misma contraseña cifrada.
7. **`migrate`**: corre tus migraciones en el destino.
8. **`copy`**:
   - Compara las tablas: todas las del origen deben existir en el destino.
   - Calcula el orden con las claves foráneas: padres antes que hijos. Las autorreferencias se copian en orden de clave primaria.
   - Vacía el destino en orden inverso (las migraciones pueden sembrar filas).
   - Copia por lotes ordenados por clave primaria (sin PK, por todas las columnas). El lote se achica solo para no pasar de ~60 000 parámetros por sentencia. Las columnas JSON se vuelven a serializar.
   - Verifica que cada tabla tenga el mismo número de filas en origen y destino.
   - En PostgreSQL adelanta las secuencias al máximo copiado (`setval`). En MySQL, `AUTO_INCREMENT` se ajusta solo.
   - Las tablas de control de migraciones también se copian: el historial queda idéntico.
9. **`switch`**: guarda el nuevo servidor del tenant, invalida la caché de búsqueda (en todas las instancias si tienes un bus), libera el cupo del origen y cierra los pools del origen en este proceso.
10. **Vuelta al estado anterior**: si estaba `active`, se reactiva.
11. **`dropSource`** (solo con `dropSource: true`): borra la base y el usuario del origen. Si falla, el tenant ya quedó bien movido: el error queda en el log y `sourceDropped` es `false`.
12. **Evento** `database.moved`.

## Qué queda en el log

Todo se registra con el `tenantId`:

| `operation`           | Cuándo                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `database.move`       | Una vez: `success` con la duración, o el error con su código                                  |
| `database.move.step`  | Una por paso (`createDatabase`, `createUser`, `migrate`, `copy`, `switch` y, si aplica, `dropSource`), con `step`, `from` y `to` |
| `database.move.table` | Una por tabla copiada, con `table`, `rows` y `durationMs`                                     |
| `tenants.maintenance` / `tenants.activate` | El cambio de estado alrededor del movimiento                             |

Si limpiar el destino o restaurar el estado falla durante un rollback, se registra como `database.move.cleanup` o `database.move.restore`. Con el CLI, `--log-file=tenancy.log` guarda todo en JSON.

### Después del cambio de servidor

Una vez guardado el servidor nuevo, **ningún fallo deshace el movimiento** ni toca la base del destino. Estos pasos, si fallan, solo quedan en el log (y en el registro de errores del tenant) y `move()` devuelve el resultado igual:

| `operation`                  | Paso                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `database.move.invalidate`   | Avisar a las demás instancias                                  |
| `database.move.releaseSlot`  | Liberar el cupo del servidor de origen                         |
| `database.move.closeSource`  | Cerrar los pools hacia el origen                               |
| `database.move.restore`      | Volver a `active`: el tenant queda en `maintenance`, actívalo con `tenancy.tenants.activate(id)` |
| `database.move.event`        | Publicar `database.moved`                                      |

Si falla `dropSource`, el tenant queda movido, `sourceDropped` es `false` y el error queda como `database.move.step` con `step: 'dropSource'`.

## El evento `database.moved`

```ts
tenancy.events.on('database.moved', async (event) => {
  const { from, to, rows, sourceDropped } = event.data;
  console.log(`${event.tenantId} pasó de ${from} a ${to}`, rows, sourceDropped);
});
```

`event.data` trae `tenantId`, `database`, `from`, `to`, `rows` y `sourceDropped`. Solo se publica cuando el movimiento termina bien. Durante el movimiento también se publican `database.created` y `database.migrated` del destino.

## Si algo falla

Si falla cualquier paso entre `createDatabase` y `switch`:

1. Se borra lo que se creó en el destino (base, schema y usuario). Si el movimiento se detuvo porque la base ya existía, no se borra nada: no es tuya.
2. Se libera el cupo reservado en el destino.
3. Si el tenant estaba `active`, se reactiva. Sigue apuntando al origen, que nunca se tocó.
4. Se lanza `TenantMoveError` con código `TENANCY_TENANT_MOVE_FAILED`, `from` y `to` en el contexto, y el error original en `cause`.

```ts
try {
  await tenancy.database.move('bolivar', { to: 'pg-2' });
} catch (error) {
  if (error instanceof TenantMoveError) {
    console.error(error.code, error.message); // TENANCY_TENANT_MOVE_FAILED
    console.error(error.cause); // el error original
  }
  throw error;
}
```

Algunos errores salen antes de empezar y conservan su propio código: `TENANCY_TENANT_NOT_FOUND`, `TENANCY_DATABASE_NOT_ASSIGNED`, `TENANCY_DATABASE_SERVER_NOT_FOUND`, `TENANCY_NO_DATABASE_SERVER_AVAILABLE` (destino sin lugar) y `TENANCY_LOCK_TIMEOUT` (el candado está tomado).

Para volver un tenant a un servidor donde quedó su base vieja, primero borra esa base: el movimiento nunca la pisa.

## Varias instancias de la app

El cambio de servidor se guarda en la base central, pero cada instancia tiene una caché de búsqueda de tenants (60 s por defecto). El movimiento invalida la caché de la instancia que lo corre. Para las demás:

- **Con un `InvalidationBus`**, todas olvidan el tenant al instante:

  ```ts
  const tenancy = createTenancy({
    plugins: [database({ driver: postgres(), central: { url: process.env.DATABASE_URL! } })],
    // Todas las réplicas olvidan el tenant movido al instante
    invalidation: redisInvalidation({ url: process.env.REDIS_URL! }),
    lookupCache: { ttlMs: 60_000 }, // sin bus, este es el retraso máximo de las demás réplicas
  });
  ```

- **Sin bus**, las demás réplicas siguen usando el servidor viejo hasta que vence el TTL. Para no perder escrituras en ese lapso, configura el bus o sube `drainMs` por encima de `lookupCache.ttlMs`.

## Límites

- Solo MySQL/MariaDB y PostgreSQL en modo base, probados con dos servidores reales. El modo schema usa el mismo camino, pero todavía no tiene test propio.
- Copia en frío: el tenant está en mantenimiento todo el tiempo. Para bases muy grandes conviene la replicación nativa del motor.
- El mantenimiento bloquea las peticiones HTTP. `tenancy.run()` y los trabajos de la cola no revisan el estado del tenant: detén los workers o asegúrate de que no escriban en ese tenant mientras se mueve. Lo que se escriba en el origen después de copiar su tabla se pierde.
- Se rechazan antes de copiar: las columnas `GENERATED ALWAYS AS IDENTITY` de PostgreSQL y los ciclos de claves foráneas entre tablas distintas.
- Solo se copian tablas. Las vistas no se copian: deben crearlas tus migraciones.
- Las instancias de ORM (Knex, Prisma, TypeORM, Sequelize, MikroORM) que apuntaban al origen se cierran tras su tiempo de gracia al llegar `database.moved`; las nuevas consultas ya van al destino.
