# ADR 0015 — Mover un tenant entre servidores

- **Estado:** aceptada
- **Fecha:** 2026-09-25

## Decisiones

1. **El origen no se toca hasta que el destino está verificado.** Orden:
   1. Candado del tenant (el mismo del aprovisionamiento).
   2. Mantenimiento: los usuarios ven 503 con el mensaje.
   3. Espera de `drainMs` para las peticiones en curso.
   4. Base y usuario en el destino, con las mismas credenciales cifradas.
   5. Migraciones.
   6. Copia.
   7. Secuencias.
   8. Verificación de filas por tabla.
   9. Cambio de `serverId`.
   10. Invalidación en todas las instancias.
   11. Vuelta al estado anterior.

   El origen solo se borra con `dropSource: true`.

2. **Copia en orden de claves foráneas.** El orden se calcula con `information_schema` (orden topológico): padres antes que hijos. Las autorreferencias se copian en orden de clave primaria, y un ciclo entre tablas distintas se rechaza con un error claro. Antes de copiar, el destino se vacía en orden inverso, porque las migraciones pueden sembrar filas. Las tablas de control de migraciones también se copian, así el historial es idéntico.
3. **Lotes ordenados por clave primaria.** Sin PK se ordena por todas las columnas; es seguro porque el tenant no recibe escrituras. El tamaño del lote se reduce solo para no pasar ~60 000 parámetros por sentencia. Las columnas JSON se vuelven a serializar.
4. **PostgreSQL:** las secuencias se adelantan al máximo copiado (`setval`), así el próximo id no choca. Las columnas `GENERATED ALWAYS AS IDENTITY` se rechazan antes de empezar. En MySQL, `AUTO_INCREMENT` se ajusta solo.
5. **Nunca se pisa una base existente.** Si el destino ya tiene una base con ese nombre (una de otro sistema, o el origen de un movimiento anterior sin `dropSource`), se detiene antes de crear nada.
6. **Si algo falla,** se borra lo creado en el destino, se libera el cupo del servidor, el tenant vuelve a su estado y el error sale como `TENANCY_TENANT_MOVE_FAILED`, con la causa original. Todo queda en el log del tenant: `database.move`, un `database.move.step` por paso y un `database.move.table` por tabla. Al terminar bien se publica `database.moved`.

7. **Después del cambio de servidor, nada deshace el movimiento.** Si fallan los pasos posteriores (avisar a las instancias, liberar el cupo del origen, cerrar sus pools, volver a `active`, borrar el origen o publicar el evento), el tenant queda en el destino y cada fallo queda en el log como `database.move.<paso>`. Si lo que falló fue la vuelta a `active`, el tenant queda en mantenimiento y se activa a mano (`tenancy.tenants.activate`).
8. **Las instancias de los ORMs** (Knex, Prisma, TypeORM, Sequelize, MikroORM) escuchan `database.moved` y cierran la instancia vieja tras su tiempo de gracia.

## Límites

- MySQL/MariaDB y PostgreSQL en modo base (probados con dos servidores reales). El modo schema usa el mismo camino, pero todavía no tiene test propio. SQL Server y SQLite, todavía no.
- Sin una instancia de `InvalidationBus`, las demás réplicas ven el cambio al vencer el TTL de su caché (60 s por defecto). Para no perder escrituras en ese lapso, configura el bus o sube `drainMs` por encima del TTL.
- El mantenimiento solo frena el tráfico HTTP: `tenancy.run()` y los workers de colas no miran el estado del tenant. Detén los workers de ese tenant (o su cola) mientras dure el movimiento, o esas escrituras en el origen se pierden.
- Los errores de validación previos (servidor inexistente, sin cupo, tenant inexistente, candado ocupado) salen con su propio código, no con `TENANCY_TENANT_MOVE_FAILED`.
- Es una copia en frío: el tenant queda en mantenimiento mientras dura. Para bases muy grandes conviene la replicación nativa del motor.
