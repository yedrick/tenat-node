import { spawn } from 'node:child_process';
import { forEachConcurrent, type Tenant } from '@tenancy-node/core';
import { hasDatabase, type CliTenancy } from '../config-loader.js';
import {
  EXIT,
  UsageError,
  intOption,
  listOption,
  requirePositional,
  stringOption,
  type Command,
  type CommandContext,
} from '../command.js';
import { generateEncryptionKeyValue } from '../keys.js';
import { formatDuration } from '../output.js';
import { progress, requireDatabase, summarize } from './shared.js';

const tenantsOption = {
  tenants: { type: 'string' },
  concurrency: { type: 'string' },
} as const;
const tenantsHelp = {
  tenants:
    'Solo estos tenants (separados por coma). Por defecto: activos, en mantenimiento y suspendidos',
  concurrency: 'Tenants en paralelo (por defecto 5)',
};

function bulkOptions(ctx: CommandContext) {
  const tenants = listOption(ctx.args, 'tenants');
  return {
    ...(tenants ? { tenants } : {}),
    concurrency: intOption(ctx.args, 'concurrency', 5),
    onTenant: progress(ctx.out, ctx.verbose),
  };
}

export const migrateCommand: Command = {
  name: 'migrate',
  summary: 'Corre las migraciones pendientes en la base de cada tenant',
  usage: 'tenancy migrate [--tenants=bolivar,tigre] [--concurrency=5]',
  options: tenantsOption,
  help: tenantsHelp,
  async run(ctx) {
    const t = requireDatabase(await ctx.tenancy());
    return summarize(ctx.out, ['migrado', 'migrados'], await t.database.migrate(bulkOptions(ctx)));
  },
};

export const rollbackCommand: Command = {
  name: 'rollback',
  summary: 'Revierte las últimas migraciones de cada tenant',
  usage: 'tenancy rollback [--tenants=..] [--steps=1] [--concurrency=5]',
  options: { ...tenantsOption, steps: { type: 'string' } },
  help: { ...tenantsHelp, steps: 'Cuántas migraciones revertir (por defecto 1)' },
  async run(ctx) {
    const t = requireDatabase(await ctx.tenancy());
    const steps = intOption(ctx.args, 'steps', 1);
    return summarize(
      ctx.out,
      ['revertido', 'revertidos'],
      await t.database.rollback({ ...bulkOptions(ctx), steps }),
    );
  },
};

export const seedCommand: Command = {
  name: 'seed',
  summary: 'Corre el seed configurado en la base de cada tenant',
  usage: 'tenancy seed [--tenants=..] [--concurrency=5]',
  options: tenantsOption,
  help: tenantsHelp,
  async run(ctx) {
    const t = requireDatabase(await ctx.tenancy());
    return summarize(ctx.out, ['sembrado', 'sembrados'], await t.database.seed(bulkOptions(ctx)));
  },
};

export const migrateStatusCommand: Command = {
  name: 'migrate:status',
  summary: 'Muestra qué migraciones corrieron en un tenant',
  usage: 'tenancy migrate:status <id>',
  async run({ args, out, tenancy }) {
    const id = requirePositional(args, 0, 'id');
    const t = requireDatabase(await tenancy());
    const status = await t.database.status(id);
    out.table(
      ['MIGRACIÓN', 'EJECUTADA'],
      status.map((s) => [s.name, s.executedAt ?? out.paint('yellow', 'pendiente')]),
    );
    out.data(status);
    return EXIT.ok;
  },
};

async function allTenants(t: CliTenancy, ids: string[] | undefined): Promise<Tenant[]> {
  if (ids) return Promise.all(ids.map((id) => t.tenants.findOrFail(id)));
  const tenants: Tenant[] = [];
  for (let page = 1; ; page++) {
    const batch = await t.tenants.list({ status: 'active', page, perPage: 500 });
    tenants.push(...batch.items);
    if (page * batch.perPage >= batch.total || batch.items.length === 0) return tenants;
  }
}

export const runCommand: Command = {
  name: 'run',
  summary: 'Ejecuta un comando por cada tenant, con TENANCY_TENANT_ID y la DATABASE_URL del tenant',
  usage: 'tenancy run "<comando>" [--tenants=..] [--concurrency=1]',
  options: tenantsOption,
  help: {
    tenants: 'Solo estos tenants (por defecto, todos los activos)',
    concurrency: 'Comandos en paralelo (por defecto 1)',
  },
  async run({ args, out, io, tenancy, verbose }) {
    const command = requirePositional(args, 0, 'command');
    const t = await tenancy();
    const tenants = await allTenants(t, listOption(args, 'tenants'));
    const concurrency = intOption(args, 'concurrency', 1);
    const result = {
      succeeded: [] as string[],
      failed: [] as { tenantId: string; error: unknown }[],
    };

    await forEachConcurrent(tenants, concurrency, async (tenant) => {
      const id = tenant.id.value;
      const env: Record<string, string | undefined> = {
        ...io.env,
        TENANCY_TENANT_ID: id,
        TENANCY_TENANT_NAME: tenant.name,
      };
      if (hasDatabase(t) && tenant.database) {
        const url = await t.database.connectionUrl(id);
        env.DATABASE_URL = url;
        env.TENANCY_DATABASE_URL = url;
        env.TENANCY_DATABASE_NAME = tenant.database.name;
      }
      const started = performance.now();
      const code = await spawnPrefixed(
        command,
        env,
        io.cwd,
        `${out.paint('cyan', `[${id}]`)} `,
        (line, stream) => (stream === 'stdout' ? io.stdout : io.stderr).write(line),
      );
      const time = out.paint('gray', formatDuration(performance.now() - started));
      if (code === 0) {
        result.succeeded.push(id);
        out.success(`${id}  ${time}`);
      } else {
        const error = new Error(`exit code ${code}`);
        result.failed.push({ tenantId: id, error });
        t.observability.report('cli.run', error, { tenantId: id, command });
        out.error(`${id}  ${out.describeError(error, verbose)}  ${time}`);
      }
    });
    return summarize(out, ['completado', 'completados'], result);
  },
};

/** Ejecuta en un shell y antepone el prefijo a cada línea de salida. */
function spawnPrefixed(
  command: string,
  env: Record<string, string | undefined>,
  cwd: string,
  prefix: string,
  write: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pipe = (stream: 'stdout' | 'stderr') => {
      let buffer = '';
      child[stream].setEncoding('utf8');
      child[stream].on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) write(`${prefix}${line}\n`, stream);
      });
      child[stream].on('end', () => {
        if (buffer) write(`${prefix}${buffer}\n`, stream);
      });
    };
    pipe('stdout');
    pipe('stderr');
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export const serversAddCommand: Command = {
  name: 'servers:add',
  summary: 'Registra (o actualiza) un servidor de base de datos para ubicar tenants',
  usage:
    'tenancy servers:add <id> --host=10.0.0.5 [--port=3306] [--admin-user=..] [--admin-password-env=VAR] [--max-tenants=500] [--weight=1] [--inactive]',
  options: {
    host: { type: 'string' },
    port: { type: 'string' },
    'admin-user': { type: 'string' },
    'admin-password-env': { type: 'string' },
    'max-tenants': { type: 'string' },
    weight: { type: 'string' },
    inactive: { type: 'boolean' },
  },
  help: {
    'admin-user': 'Usuario con permiso de CREATE DATABASE (por defecto, el de la configuración)',
    'admin-password-env':
      'Variable de entorno con la contraseña (así no queda en el historial del shell); se guarda cifrada',
    'max-tenants': 'Máximo de tenants en este servidor (sin límite si se omite)',
    weight: 'Peso para la estrategia "weighted"',
    inactive: 'Registrar sin recibir tenants nuevos',
  },
  async run({ args, out, io, tenancy }) {
    const id = requirePositional(args, 0, 'id');
    const host = stringOption(args, 'host');
    if (!host) throw new UsageError('Missing --host');
    const passwordVar = stringOption(args, 'admin-password-env');
    const password = passwordVar ? io.env[passwordVar] : undefined;
    if (passwordVar && password === undefined)
      throw new UsageError(`Environment variable ${passwordVar} is not set`);
    const adminUser = stringOption(args, 'admin-user');
    const t = requireDatabase(await tenancy());
    const server = await t.database.servers.add({
      id,
      host,
      ...(stringOption(args, 'port') ? { port: intOption(args, 'port', 0) } : {}),
      ...(adminUser ? { adminUsername: adminUser } : {}),
      ...(password !== undefined ? { adminPassword: password } : {}),
      ...(stringOption(args, 'max-tenants')
        ? { maxTenants: intOption(args, 'max-tenants', 0) }
        : {}),
      ...(stringOption(args, 'weight') ? { weight: intOption(args, 'weight', 1) } : {}),
      isActive: args.values.inactive !== true,
    });
    out.success(`servidor ${server.id} (${server.host}:${server.port}) registrado`);
    out.data({ ...server, adminPasswordEncrypted: server.adminPasswordEncrypted ? '***' : null });
    return EXIT.ok;
  },
};

export const serversListCommand: Command = {
  name: 'servers:list',
  summary: 'Lista los servidores de base de datos y cuántos tenants tiene cada uno',
  usage: 'tenancy servers:list',
  async run({ out, tenancy }) {
    const t = requireDatabase(await tenancy());
    const servers = await t.database.servers.list();
    out.table(
      ['ID', 'MOTOR', 'HOST', 'PUERTO', 'TENANTS', 'MÁX', 'PESO', 'ACTIVO'],
      servers.map((s) => [
        s.id,
        s.driver,
        s.host,
        s.port,
        s.tenantCount,
        s.maxTenants ?? '∞',
        s.weight,
        s.isActive,
      ]),
    );
    out.data(
      servers.map((s) => ({
        ...s,
        adminPasswordEncrypted: s.adminPasswordEncrypted ? '***' : null,
      })),
    );
    return EXIT.ok;
  },
};

export const keyGenerateCommand: Command = {
  name: 'key:generate',
  summary: 'Genera una llave nueva para TENANCY_KEY',
  usage: 'tenancy key:generate',
  async run({ out }) {
    const key = generateEncryptionKeyValue();
    out.line(key);
    out.data({ key });
    return EXIT.ok;
  },
};

export const keyRotateCommand: Command = {
  name: 'key:rotate',
  summary: 'Vuelve a cifrar todos los secretos con la llave actual (TENANCY_KEY)',
  usage: 'tenancy key:rotate',
  async run({ out, tenancy }) {
    const t = requireDatabase(await tenancy());
    const { updated } = await t.database.rotateKey();
    out.success(
      updated === 0
        ? 'Todo ya estaba cifrado con la llave actual'
        : `${updated} secretos cifrados de nuevo`,
    );
    out.info(
      out.paint(
        'gray',
        'Cuando todos los procesos usen la llave nueva, puedes quitar la anterior de previousKeys.',
      ),
    );
    out.data({ updated });
    return EXIT.ok;
  },
};

export const moveCommand: Command = {
  name: 'move',
  summary: 'Mueve la base de un tenant a otro servidor (con el tenant en mantenimiento mientras tanto)',
  usage: 'tenancy move <id> --to=<servidor> [--drop-source] [--batch-size=1000] [--drain-ms=1000]',
  options: {
    to: { type: 'string' },
    'drop-source': { type: 'boolean' },
    'batch-size': { type: 'string' },
    'drain-ms': { type: 'string' },
    message: { type: 'string' },
  },
  help: {
    to: 'Id del servidor de destino (ver `tenancy servers:list`)',
    'drop-source':
      'Borrar la base y el usuario del servidor de origen cuando el destino ya está verificado',
    'batch-size': 'Filas por lote al copiar (por defecto 1000)',
    'drain-ms': 'Espera tras activar el mantenimiento, para que terminen las peticiones en curso',
    message: 'Mensaje de mantenimiento que ven los usuarios mientras dura',
  },
  async run({ args, out, verbose, tenancy }) {
    const id = requirePositional(args, 0, 'id');
    const to = stringOption(args, 'to');
    if (!to) throw new UsageError('Missing --to=<server>');
    const t = requireDatabase(await tenancy());
    const started = performance.now();
    const message = stringOption(args, 'message');
    out.info(`Moviendo ${id} a ${to}...`);
    const result = await t.database.move(id, {
      to,
      dropSource: args.values['drop-source'] === true,
      batchSize: intOption(args, 'batch-size', 1000),
      drainMs: intOption(args, 'drain-ms', 1000, 0),
      ...(message ? { maintenanceMessage: message } : {}),
      onProgress: ({ table, copied, total }) => {
        if (verbose) out.info(out.paint('gray', `  ${table}: ${copied}/${total}`));
      },
    });
    // Desde el resultado: incluye las tablas vacías (que no generan progreso).
    for (const [table, count] of Object.entries(result.rows))
      out.info(`  ${out.paint('green', '✓')} ${table}: ${count} filas`);
    const rows = Object.values(result.rows).reduce((a, b) => a + b, 0);
    out.success(
      `tenant ${id} movido de ${result.from} a ${result.to}: ${Object.keys(result.rows).length} tablas, ${rows} filas en ${formatDuration(performance.now() - started)}`,
    );
    if (!result.sourceDropped)
      out.info(
        out.paint(
          'gray',
          `La base ${result.database} sigue en ${result.from}. Bórrala cuando confirmes que todo anda bien.`,
        ),
      );
    out.data(result);
    return EXIT.ok;
  },
};
