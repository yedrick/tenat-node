import {
  sql,
  type ColumnDefinitionBuilder,
  type CreateTableBuilder,
  type Kysely,
  type Migration,
  type RawBuilder,
} from 'kysely';
import type { DialectKind } from '../drivers/driver.js';
import type { AnyDB } from '../kysely-any.js';
import { TablePrefixPlugin } from './table-prefix-plugin.js';
import { MssqlDdlPlugin } from '../dialect.js';

type Db = Kysely<AnyDB>;
type Table = CreateTableBuilder<string, string>;
type Col = (col: ColumnDefinitionBuilder) => ColumnDefinitionBuilder;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(','));

/** Tipos y valores por defecto de cada motor (MySQL 8+/MariaDB 10.6+ y PostgreSQL 13+). */
function dialect(kind: DialectKind) {
  const mysql = kind === 'mysql';
  if (kind === 'mssql') {
    return {
      mysql: false,
      sqlite: false,
      mssql: true,
      ts: sql`datetime2(3)`,
      now: sql`sysutcdatetime()`,
      json: sql`nvarchar(max)`,
      int: sql`int`,
      small: sql`smallint`,
      bigint: sql`bigint`,
    };
  }
  if (kind === 'sqlite') {
    return {
      mysql: false,
      sqlite: true,
      mssql: false,
      // Fechas como texto ISO 8601 (se comparan bien como texto); el driver convierte los parámetros.
      ts: sql`text`,
      now: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      json: sql`text`,
      int: sql`integer`,
      small: sql`integer`,
      bigint: sql`integer`,
    };
  }
  return {
    mysql,
    sqlite: false,
    mssql: false,
    ts: mysql ? sql`datetime(3)` : sql`timestamptz`,
    now: mysql ? sql`CURRENT_TIMESTAMP(3)` : sql`now()`,
    json: mysql ? sql`json` : sql`jsonb`,
    int: mysql ? sql`int unsigned` : sql`integer`,
    small: mysql ? sql`smallint unsigned` : sql`smallint`,
    bigint: mysql ? sql`bigint unsigned` : sql`bigint`,
  };
}

/**
 * Migraciones de las tablas `tenancy_*` de la base central.
 * Se escriben una vez y generan el SQL correcto para cada motor.
 */
export function centralMigrations(prefix: string, kind: DialectKind): Record<string, Migration> {
  const d = dialect(kind);
  const n = (name: string) => `${prefix}${name}`;
  const scoped = (db: Db) => {
    const prefixed = db.withPlugin(new TablePrefixPlugin(prefix));
    // SQL Server: nvarchar, nvarchar(max) y bit en lugar de varchar, text y boolean.
    return d.mssql ? prefixed.withPlugin(new MssqlDdlPlugin()) : prefixed;
  };

  const table = (db: Db, name: string): Table => {
    const builder = scoped(db).schema.createTable(name);
    return d.mysql
      ? builder.modifyEnd(sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
      : builder;
  };
  const id: Col = (c) =>
    d.mysql
      ? c.notNull().autoIncrement().primaryKey()
      : d.sqlite
        ? c.primaryKey().autoIncrement()
        : d.mssql
          ? c.identity().primaryKey()
          : c.generatedAlwaysAsIdentity().primaryKey();
  const createdAt = (t: Table) =>
    t.addColumn('created_at', d.ts, (c) => c.notNull().defaultTo(d.now));
  const timestamps = (t: Table) =>
    createdAt(t).addColumn('updated_at', d.ts, (c) => {
      const base = c.notNull().defaultTo(d.now);
      return d.mysql ? base.modifyEnd(sql`ON UPDATE CURRENT_TIMESTAMP(3)`) : base;
    });
  const check = (t: Table, name: string, column: string, values: readonly string[]) =>
    t.addCheckConstraint(n(name), sql`${sql.ref(column)} IN (${list(values)})`);
  const index = (db: Db, name: string, tableName: string, columns: string[]) =>
    scoped(db).schema.createIndex(n(name)).on(tableName).columns(columns).execute();

  const up = async (db: Db): Promise<void> => {
    // Servidores donde se crean las bases de los tenants
    let servers = table(db, 'database_servers')
      .addColumn('id', 'varchar(50)', (c) => c.primaryKey())
      .addColumn('driver', 'varchar(20)', (c) => c.notNull())
      .addColumn('host', 'varchar(255)', (c) => c.notNull())
      .addColumn('port', d.int, (c) => c.notNull())
      .addColumn('admin_username', 'varchar(64)')
      .addColumn('admin_password_encrypted', 'text')
      .addColumn('max_tenants', d.int)
      .addColumn('tenant_count', d.int, (c) => c.notNull().defaultTo(0))
      .addColumn('weight', d.small, (c) => c.notNull().defaultTo(1))
      .addColumn('is_active', 'boolean', (c) => c.notNull().defaultTo(true));
    servers = check(timestamps(servers), 'chk_servers_driver', 'driver', [
      'mysql',
      'mariadb',
      'postgres',
      'sqlite',
      'mssql',
    ]);
    await servers.execute();

    // Registro maestro de tenants
    let tenants = table(db, 'tenants')
      .addColumn('id', 'varchar(40)', (c) => c.primaryKey())
      .addColumn('name', 'varchar(150)', (c) => c.notNull())
      .addColumn('status', 'varchar(20)', (c) => c.notNull().defaultTo('provisioning'))
      .addColumn('plan', 'varchar(50)')
      .addColumn('data', d.json, (c) => c.notNull())
      .addColumn('theme', d.json)
      .addColumn('database_server_id', 'varchar(50)')
      .addColumn('database_name', 'varchar(64)')
      .addColumn('schema_name', 'varchar(63)')
      .addColumn('database_username', 'varchar(64)')
      .addColumn('database_password_encrypted', 'text')
      .addColumn('maintenance_message', 'varchar(255)')
      .addColumn('provisioned_at', d.ts)
      .addColumn('suspended_at', d.ts);
    tenants = timestamps(tenants)
      .addColumn('deleted_at', d.ts)
      .addForeignKeyConstraint(
        n('fk_tenants_server'),
        ['database_server_id'],
        'database_servers',
        ['id'],
        (c) => c.onDelete('restrict'),
      );
    tenants = check(tenants, 'chk_tenants_status', 'status', [
      'provisioning',
      'active',
      'maintenance',
      'suspended',
      'failed',
      'deleting',
    ]);
    await tenants.execute();
    if (d.mssql) {
      // SQL Server trata NULL como un valor en UNIQUE: la unicidad (servidor, base) va en un índice filtrado.
      await scoped(db)
        .schema.createIndex(n('uq_tenants_database'))
        .on('tenants')
        .columns(['database_server_id', 'database_name'])
        .unique()
        .where(sql.ref('database_name'), 'is not', null)
        .execute();
    } else {
      await scoped(db)
        .schema.createIndex(n('uq_tenants_database'))
        .on('tenants')
        .columns(['database_server_id', 'database_name'])
        .unique()
        .execute();
    }
    await index(db, 'idx_tenants_status', 'tenants', ['status']);

    // Dominios
    let domains = table(db, 'domains')
      .addColumn('id', d.bigint, id)
      .addColumn('tenant_id', 'varchar(40)', (c) => c.notNull())
      .addColumn('domain', 'varchar(253)', (c) => c.notNull())
      .addColumn('is_primary', 'boolean', (c) => c.notNull().defaultTo(false));
    if (d.mysql) {
      // Un solo dominio principal por tenant: columna generada + UNIQUE (MySQL no tiene índices parciales)
      domains = domains.addColumn('primary_tenant_id', 'varchar(40)', (c) =>
        c.generatedAlwaysAs(sql`IF(is_primary, tenant_id, NULL)`).stored(),
      );
    }
    domains = timestamps(domains.addColumn('verified_at', d.ts))
      .addUniqueConstraint(n('uq_domains_domain'), ['domain'])
      .addForeignKeyConstraint(n('fk_domains_tenant'), ['tenant_id'], 'tenants', ['id'], (c) =>
        c.onDelete('restrict'),
      );
    if (d.mysql)
      domains = domains.addUniqueConstraint(n('uq_domains_one_primary'), ['primary_tenant_id']);
    await domains.execute();
    await index(db, 'idx_domains_tenant', 'domains', ['tenant_id']);
    if (!d.mysql) {
      await scoped(db)
        .schema.createIndex(n('uq_domains_one_primary'))
        .on('domains')
        .column('tenant_id')
        .unique()
        .where(sql.ref('is_primary'), '=', true)
        .execute();
    }

    // Historial de aprovisionamiento
    let steps = table(db, 'provisioning_steps')
      .addColumn('id', d.bigint, id)
      .addColumn('tenant_id', 'varchar(40)', (c) => c.notNull())
      .addColumn('run_id', 'char(26)', (c) => c.notNull())
      .addColumn('step', 'varchar(50)', (c) => c.notNull())
      .addColumn('status', 'varchar(20)', (c) => c.notNull().defaultTo('pending'))
      .addColumn('attempt', d.small, (c) => c.notNull().defaultTo(1))
      .addColumn('error', 'text')
      .addColumn('started_at', d.ts)
      .addColumn('finished_at', d.ts)
      .addColumn('duration_ms', d.int);
    steps = createdAt(steps).addForeignKeyConstraint(
      n('fk_steps_tenant'),
      ['tenant_id'],
      'tenants',
      ['id'],
      (c) => c.onDelete('restrict'),
    );
    steps = check(steps, 'chk_steps_status', 'status', [
      'pending',
      'running',
      'completed',
      'failed',
      'skipped',
    ]);
    await steps.execute();
    await index(db, 'idx_steps_tenant_run', 'provisioning_steps', ['tenant_id', 'run_id']);

    // Outbox de eventos (sin FK a propósito: sobrevive al borrado del tenant)
    let outbox = table(db, 'event_outbox')
      .addColumn('id', 'char(26)', (c) => c.primaryKey())
      .addColumn('type', 'varchar(100)', (c) => c.notNull())
      .addColumn('tenant_id', 'varchar(40)')
      .addColumn('payload', d.json, (c) => c.notNull())
      .addColumn('status', 'varchar(20)', (c) => c.notNull().defaultTo('pending'))
      .addColumn('attempts', d.small, (c) => c.notNull().defaultTo(0))
      .addColumn('available_at', d.ts, (c) => c.notNull().defaultTo(d.now))
      .addColumn('locked_until', d.ts)
      .addColumn('published_at', d.ts)
      .addColumn('last_error', 'text');
    outbox = check(createdAt(outbox), 'chk_outbox_status', 'status', [
      'pending',
      'processing',
      'published',
      'failed',
    ]);
    await outbox.execute();
    if (d.mysql) await index(db, 'idx_outbox_pending', 'event_outbox', ['status', 'available_at']);
    else {
      await scoped(db)
        .schema.createIndex(n('idx_outbox_pending'))
        .on('event_outbox')
        .column('available_at')
        .where(sql.ref('status'), '=', 'pending')
        .execute();
    }
    await index(db, 'idx_outbox_tenant', 'event_outbox', ['tenant_id']);

    // Webhooks
    let webhooks = table(db, 'webhook_endpoints')
      .addColumn('id', d.bigint, id)
      .addColumn('tenant_id', 'varchar(40)')
      .addColumn('name', 'varchar(100)', (c) => c.notNull())
      .addColumn('url', 'varchar(2048)', (c) => c.notNull())
      .addColumn('events', d.json, (c) => c.notNull())
      .addColumn('secret_encrypted', 'text', (c) => c.notNull())
      .addColumn('is_active', 'boolean', (c) => c.notNull().defaultTo(true))
      .addColumn('circuit_state', 'varchar(20)', (c) => c.notNull().defaultTo('closed'))
      .addColumn('consecutive_failures', d.small, (c) => c.notNull().defaultTo(0))
      .addColumn('paused_until', d.ts);
    webhooks = timestamps(webhooks).addForeignKeyConstraint(
      n('fk_webhooks_tenant'),
      ['tenant_id'],
      'tenants',
      ['id'],
      (c) => c.onDelete('restrict'),
    );
    webhooks = check(webhooks, 'chk_webhooks_circuit', 'circuit_state', [
      'closed',
      'open',
      'half_open',
    ]);
    await webhooks.execute();
    await index(db, 'idx_webhooks_tenant', 'webhook_endpoints', ['tenant_id']);

    let deliveries = table(db, 'webhook_deliveries')
      .addColumn('id', d.bigint, id)
      .addColumn('endpoint_id', d.bigint, (c) => c.notNull())
      .addColumn('event_id', 'char(26)', (c) => c.notNull())
      .addColumn('status', 'varchar(20)', (c) => c.notNull().defaultTo('pending'))
      .addColumn('attempt', d.small, (c) => c.notNull().defaultTo(0))
      .addColumn('http_status', d.small)
      .addColumn('response_ms', d.int)
      .addColumn('response_body', 'varchar(2000)')
      .addColumn('next_retry_at', d.ts);
    deliveries = timestamps(deliveries)
      .addUniqueConstraint(n('uq_deliveries_endpoint_event'), ['endpoint_id', 'event_id'])
      .addForeignKeyConstraint(
        n('fk_deliveries_endpoint'),
        ['endpoint_id'],
        'webhook_endpoints',
        ['id'],
        (c) => c.onDelete('cascade'),
      );
    deliveries = check(deliveries, 'chk_deliveries_status', 'status', [
      'pending',
      'success',
      'failed',
      'dead',
    ]);
    await deliveries.execute();
    await index(db, 'idx_deliveries_retry', 'webhook_deliveries', ['status', 'next_retry_at']);

    // Panel admin
    let users = table(db, 'admin_users')
      .addColumn('id', d.bigint, id)
      .addColumn('email', 'varchar(191)', (c) => c.notNull())
      .addColumn('name', 'varchar(150)', (c) => c.notNull())
      .addColumn('password_hash', 'varchar(255)', (c) => c.notNull())
      .addColumn('role', 'varchar(20)', (c) => c.notNull().defaultTo('support'))
      .addColumn('two_factor_secret_encrypted', 'text')
      .addColumn('is_active', 'boolean', (c) => c.notNull().defaultTo(true))
      .addColumn('last_login_at', d.ts);
    users = timestamps(users).addUniqueConstraint(n('uq_admin_users_email'), ['email']);
    users = check(users, 'chk_admin_users_role', 'role', ['owner', 'admin', 'support']);
    await users.execute();

    await createdAt(
      table(db, 'admin_sessions')
        .addColumn('id', 'char(64)', (c) => c.primaryKey())
        .addColumn('admin_user_id', d.bigint, (c) => c.notNull())
        .addColumn('ip', 'varchar(45)')
        .addColumn('user_agent', 'varchar(255)')
        .addColumn('expires_at', d.ts, (c) => c.notNull()),
    )
      .addForeignKeyConstraint(
        n('fk_sessions_user'),
        ['admin_user_id'],
        'admin_users',
        ['id'],
        (c) => c.onDelete('cascade'),
      )
      .execute();
    await index(db, 'idx_sessions_user', 'admin_sessions', ['admin_user_id']);
    await index(db, 'idx_sessions_expires', 'admin_sessions', ['expires_at']);

    await createdAt(
      table(db, 'impersonation_tokens')
        .addColumn('token_hash', 'char(64)', (c) => c.primaryKey())
        .addColumn('tenant_id', 'varchar(40)', (c) => c.notNull())
        .addColumn('user_identifier', 'varchar(191)', (c) => c.notNull())
        .addColumn('admin_user_id', d.bigint, (c) => c.notNull())
        .addColumn('redirect_path', 'varchar(500)', (c) => c.notNull().defaultTo('/'))
        .addColumn('expires_at', d.ts, (c) => c.notNull())
        .addColumn('used_at', d.ts),
    )
      .addForeignKeyConstraint(
        n('fk_impersonation_tenant'),
        ['tenant_id'],
        'tenants',
        ['id'],
        (c) => c.onDelete('restrict'),
      )
      .addForeignKeyConstraint(
        n('fk_impersonation_admin'),
        ['admin_user_id'],
        'admin_users',
        ['id'],
        (c) => c.onDelete('cascade'),
      )
      .execute();
    await index(db, 'idx_impersonation_expires', 'impersonation_tokens', ['expires_at']);

    // Auditoría (sin FK a propósito)
    await createdAt(
      table(db, 'audit_log')
        .addColumn('id', d.bigint, id)
        .addColumn('admin_user_id', d.bigint)
        .addColumn('action', 'varchar(100)', (c) => c.notNull())
        .addColumn('tenant_id', 'varchar(40)')
        .addColumn('target_type', 'varchar(50)')
        .addColumn('target_id', 'varchar(100)')
        .addColumn('changes', d.json)
        .addColumn('ip', 'varchar(45)'),
    ).execute();
    await index(db, 'idx_audit_created', 'audit_log', ['created_at']);
    await index(db, 'idx_audit_tenant', 'audit_log', ['tenant_id']);
    await index(db, 'idx_audit_user', 'audit_log', ['admin_user_id']);
  };

  const down = async (db: Db): Promise<void> => {
    for (const name of [
      'audit_log',
      'impersonation_tokens',
      'admin_sessions',
      'admin_users',
      'webhook_deliveries',
      'webhook_endpoints',
      'event_outbox',
      'provisioning_steps',
      'domains',
      'tenants',
      'database_servers',
    ]) {
      await scoped(db).schema.dropTable(name).ifExists().execute();
    }
  };

  // Fase 5: una fila de outbox por evento y destino, y el cuerpo de cada entrega de webhook.
  const eventsUp = async (db: Db): Promise<void> => {
    await scoped(db)
      .schema.alterTable('event_outbox')
      .addColumn('destination', 'varchar(50)', (c) => c.notNull().defaultTo(''))
      .execute();
    await scoped(db)
      .schema.alterTable('event_outbox')
      .addColumn('routing_key', 'varchar(255)')
      .execute();
    await scoped(db).schema.alterTable('webhook_deliveries').addColumn('payload', d.json).execute();
    await scoped(db)
      .schema.alterTable('webhook_deliveries')
      .addColumn('last_error', 'text')
      .execute();
  };
  const eventsDown = async (db: Db): Promise<void> => {
    await scoped(db).schema.alterTable('webhook_deliveries').dropColumn('last_error').execute();
    await scoped(db).schema.alterTable('webhook_deliveries').dropColumn('payload').execute();
    await scoped(db).schema.alterTable('event_outbox').dropColumn('routing_key').execute();
    await scoped(db).schema.alterTable('event_outbox').dropColumn('destination').execute();
  };

  // 0.11: módulos sueltos de cada tenant, solicitudes de la web comercial y avisos.
  const plansUp = async (db: Db): Promise<void> => {
    await scoped(db).schema.alterTable('tenants').addColumn('features', d.json).execute();

    let leads = table(db, 'leads')
      .addColumn('id', d.bigint, id)
      .addColumn('name', 'varchar(150)', (c) => c.notNull())
      .addColumn('company', 'varchar(150)')
      .addColumn('city', 'varchar(100)')
      .addColumn('phone', 'varchar(50)')
      .addColumn('email', 'varchar(191)')
      .addColumn('plan', 'varchar(50)')
      .addColumn('message', 'text')
      .addColumn('data', d.json)
      .addColumn('status', 'varchar(20)', (c) => c.notNull().defaultTo('new'))
      .addColumn('notes', 'text')
      // Sin FK a propósito: la solicitud sobrevive al borrado del tenant.
      .addColumn('tenant_id', 'varchar(40)')
      .addColumn('ip', 'varchar(45)')
      .addColumn('consent_at', d.ts);
    leads = check(timestamps(leads), 'chk_leads_status', 'status', [
      'new',
      'contacted',
      'converted',
      'discarded',
    ]);
    await leads.execute();
    await index(db, 'idx_leads_status', 'leads', ['status', 'created_at']);
    await index(db, 'idx_leads_created', 'leads', ['created_at']);

    // Avisos de la plataforma a sus tenants.
    let notifications = table(db, 'notifications')
      .addColumn('id', 'char(26)', (c) => c.primaryKey())
      .addColumn('title', 'varchar(150)', (c) => c.notNull())
      .addColumn('body', 'text', (c) => c.notNull())
      .addColumn('level', 'varchar(20)', (c) => c.notNull().defaultTo('info'))
      .addColumn('audience_type', 'varchar(20)', (c) => c.notNull())
      .addColumn('audience_values', d.json)
      .addColumn('roles', d.json)
      .addColumn('link_url', 'varchar(2000)')
      .addColumn('link_label', 'varchar(60)')
      .addColumn('starts_at', d.ts)
      .addColumn('expires_at', d.ts)
      .addColumn('created_by', 'varchar(191)');
    notifications = check(createdAt(notifications), 'chk_notifications_level', 'level', [
      'info',
      'success',
      'warning',
      'critical',
    ]);
    notifications = check(notifications, 'chk_notifications_audience', 'audience_type', [
      'all',
      'tenants',
      'plans',
    ]);
    await notifications.execute();
    await index(db, 'idx_notifications_created', 'notifications', ['created_at']);
    await index(db, 'idx_notifications_expires', 'notifications', ['expires_at']);

    // Sin FK al tenant a propósito (como la auditoría); sí al aviso, para borrarlas con él.
    await table(db, 'notification_reads')
      .addColumn('notification_id', 'char(26)', (c) => c.notNull())
      .addColumn('tenant_id', 'varchar(40)', (c) => c.notNull())
      .addColumn('user_id', 'varchar(191)', (c) => c.notNull())
      .addColumn('read_at', d.ts, (c) => c.notNull())
      .addPrimaryKeyConstraint(n('pk_notification_reads'), ['notification_id', 'tenant_id', 'user_id'])
      .addForeignKeyConstraint(
        n('fk_reads_notification'),
        ['notification_id'],
        'notifications',
        ['id'],
        (c) => c.onDelete('cascade'),
      )
      .execute();

    await createdAt(
      table(db, 'notification_devices')
        .addColumn('token', 'varchar(512)', (c) => c.primaryKey())
        .addColumn('tenant_id', 'varchar(40)', (c) => c.notNull())
        .addColumn('user_id', 'varchar(191)', (c) => c.notNull())
        .addColumn('platform', 'varchar(10)', (c) => c.notNull())
        .addColumn('roles', d.json)
        .addColumn('last_seen_at', d.ts, (c) => c.notNull()),
    ).execute();
    await index(db, 'idx_devices_tenant_user', 'notification_devices', ['tenant_id', 'user_id']);
  };
  const plansDown = async (db: Db): Promise<void> => {
    await scoped(db).schema.dropTable('notification_devices').ifExists().execute();
    await scoped(db).schema.dropTable('notification_reads').ifExists().execute();
    await scoped(db).schema.dropTable('notifications').ifExists().execute();
    await scoped(db).schema.dropTable('leads').ifExists().execute();
    await scoped(db).schema.alterTable('tenants').dropColumn('features').execute();
  };

  // 0.11: cobros a los tenants (suscripción, facturas y pagos). Montos en centavos.
  const billingUp = async (db: Db): Promise<void> => {
    let subscriptions = table(db, 'billing_subscriptions')
      .addColumn('tenant_id', 'varchar(40)', (c) => c.primaryKey())
      .addColumn('plan', 'varchar(50)')
      .addColumn('period', 'varchar(10)', (c) => c.notNull())
      .addColumn('status', 'varchar(20)', (c) => c.notNull())
      .addColumn('currency', 'char(3)', (c) => c.notNull())
      .addColumn('amount_cents', d.bigint, (c) => c.notNull())
      .addColumn('current_period_start', d.ts, (c) => c.notNull())
      .addColumn('current_period_end', d.ts, (c) => c.notNull())
      .addColumn('provider', 'varchar(30)', (c) => c.notNull())
      .addColumn('provider_ref', 'varchar(191)')
      .addColumn('canceled_at', d.ts);
    subscriptions = check(timestamps(subscriptions), 'chk_subscriptions_status', 'status', [
      'trialing',
      'active',
      'past_due',
      'canceled',
    ]);
    await subscriptions.execute();
    await index(db, 'idx_subscriptions_end', 'billing_subscriptions', ['status', 'current_period_end']);

    let invoices = table(db, 'billing_invoices')
      .addColumn('id', 'char(26)', (c) => c.primaryKey())
      .addColumn('tenant_id', 'varchar(40)', (c) => c.notNull())
      .addColumn('description', 'varchar(255)', (c) => c.notNull())
      .addColumn('currency', 'char(3)', (c) => c.notNull())
      .addColumn('amount_cents', d.bigint, (c) => c.notNull())
      .addColumn('paid_cents', d.bigint, (c) => c.notNull().defaultTo(0))
      .addColumn('status', 'varchar(10)', (c) => c.notNull())
      .addColumn('period_start', d.ts)
      .addColumn('period_end', d.ts)
      .addColumn('due_at', d.ts, (c) => c.notNull())
      .addColumn('paid_at', d.ts)
      .addColumn('provider', 'varchar(30)')
      .addColumn('provider_ref', 'varchar(191)')
      .addColumn('checkout_url', 'varchar(2000)');
    invoices = check(timestamps(invoices), 'chk_invoices_status', 'status', ['open', 'paid', 'void']);
    await invoices.execute();
    await index(db, 'idx_invoices_tenant', 'billing_invoices', ['tenant_id', 'created_at']);
    await index(db, 'idx_invoices_due', 'billing_invoices', ['status', 'due_at']);
    await index(db, 'idx_invoices_provider', 'billing_invoices', ['provider', 'provider_ref']);

    await createdAt(
      table(db, 'billing_payments')
        .addColumn('id', 'char(26)', (c) => c.primaryKey())
        .addColumn('invoice_id', 'char(26)', (c) => c.notNull())
        .addColumn('tenant_id', 'varchar(40)', (c) => c.notNull())
        .addColumn('amount_cents', d.bigint, (c) => c.notNull())
        .addColumn('currency', 'char(3)', (c) => c.notNull())
        .addColumn('method', 'varchar(30)', (c) => c.notNull())
        .addColumn('reference', 'varchar(191)')
        .addColumn('provider', 'varchar(30)', (c) => c.notNull())
        .addColumn('provider_ref', 'varchar(191)')
        .addColumn('paid_at', d.ts, (c) => c.notNull())
        .addColumn('recorded_by', 'varchar(191)'),
    )
      .addForeignKeyConstraint(
        n('fk_payments_invoice'),
        ['invoice_id'],
        'billing_invoices',
        ['id'],
        (c) => c.onDelete('restrict'),
      )
      .execute();
    await index(db, 'idx_payments_invoice', 'billing_payments', ['invoice_id']);
    await index(db, 'idx_payments_tenant', 'billing_payments', ['tenant_id', 'paid_at']);
  };
  const billingDown = async (db: Db): Promise<void> => {
    for (const name of ['billing_payments', 'billing_invoices', 'billing_subscriptions'])
      await scoped(db).schema.dropTable(name).ifExists().execute();
  };

  // 0.11.1: un pago de pasarela (provider + provider_ref) se registra una sola vez, aunque el
  // webhook llegue repetido y en paralelo. Los pagos manuales (provider_ref NULL) no chocan.
  const paymentsUniqueUp = async (db: Db): Promise<void> => {
    let unique = scoped(db)
      .schema.createIndex(n('uq_payments_provider_ref'))
      .on('billing_payments')
      .columns(['provider', 'provider_ref'])
      .unique();
    // SQL Server trata NULL como un valor en UNIQUE: índice filtrado.
    if (d.mssql) unique = unique.where(sql.ref('provider_ref'), 'is not', null);
    await unique.execute();
  };
  const paymentsUniqueDown = async (db: Db): Promise<void> => {
    let drop = scoped(db).schema.dropIndex(n('uq_payments_provider_ref'));
    if (d.mysql || d.mssql) drop = drop.on('billing_payments');
    await drop.execute();
  };

  // 0.12: planes y marca de la plataforma editables desde el panel.
  const settingsUp = async (db: Db): Promise<void> => {
    await timestamps(
      table(db, 'plan_settings')
        .addColumn('plan_id', 'varchar(50)', (c) => c.primaryKey())
        .addColumn('settings', d.json, (c) => c.notNull())
        .addColumn('archived', 'boolean', (c) => c.notNull().defaultTo(false))
        .addColumn('updated_by', 'varchar(191)'),
    ).execute();
    await timestamps(
      table(db, 'platform_settings')
        .addColumn('key', 'varchar(64)', (c) => c.primaryKey())
        .addColumn('value', d.json, (c) => c.notNull())
        .addColumn('updated_by', 'varchar(191)'),
    ).execute();
  };
  const settingsDown = async (db: Db): Promise<void> => {
    await scoped(db).schema.dropTable('platform_settings').ifExists().execute();
    await scoped(db).schema.dropTable('plan_settings').ifExists().execute();
  };

  return {
    '2026_09_25_000001_create_tenancy_tables': { up, down },
    '2026_09_26_000001_outbox_destinations': { up: eventsUp, down: eventsDown },
    '2026_10_17_000001_plans_leads_notifications': { up: plansUp, down: plansDown },
    '2026_10_17_000002_billing': { up: billingUp, down: billingDown },
    '2026_10_18_000001_billing_payments_unique': { up: paymentsUniqueUp, down: paymentsUniqueDown },
    '2026_10_18_000002_plan_and_platform_settings': { up: settingsUp, down: settingsDown },
  };
}

export type { RawBuilder };
