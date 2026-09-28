---
layout: home
hero:
  name: tenancy-node
  text: Multi-tenancy para Node.js
  tagline: Una base (o un schema) por tenant, el tenant correcto en cada petición y cada error con su tenant en el log. Para Fastify, Express o node:http.
  actions:
    - theme: brand
      text: Primeros pasos
      link: /guia/empezar
    - theme: alt
      text: Qué es
      link: /guia/introduccion
    - theme: alt
      text: GitHub
      link: https://github.com/yedrick/tenat-node
features:
  - title: Aislamiento real
    details: Base de datos por tenant en MySQL/MariaDB, PostgreSQL, SQLite o SQL Server, o un schema por tenant en PostgreSQL con un rol que no puede leer a los demás.
  - title: El contexto viaja solo
    details: AsyncLocalStorage lleva el tenant por todo el código asíncrono; tenancy.db(), la caché, los archivos y las colas ya apuntan a él.
  - title: Aprovisionamiento idempotente
    details: Crear un tenant crea su base, su usuario, corre las migraciones y el seed, con candado, reintentos y cada paso registrado.
  - title: Observabilidad por tenant
    details: Cada log trae tenantId, operación, resultado y duración; cada error queda con su tenant. Trazas OpenTelemetry y métricas Prometheus.
  - title: Eventos hacia afuera
    details: CloudEvents con outbox transaccional hacia webhooks firmados, RabbitMQ, Redis Streams, Kafka o NATS.
  - title: Panel y CLI
    details: Admin API con roles, 2FA y auditoría, interfaz React, y un CLI para crear, migrar, correr comandos y mover tenants entre servidores.
---
