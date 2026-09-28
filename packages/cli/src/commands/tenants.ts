import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  forEachConcurrent,
  isTenantStatus,
  type Tenant,
  type TenantStatus,
} from '@tenancy-node/core';
import {
  EXIT,
  UsageError,
  intOption,
  listOption,
  requirePositional,
  stringOption,
  type Command,
} from '../command.js';
import { csvRecords } from '../csv.js';
import { formatDuration } from '../output.js';
import { requireDatabase, summarize } from './shared.js';

function parseJsonOption(
  raw: string | undefined,
  name: string,
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === '') return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new UsageError(`${name} must be a JSON object`);
  }
}

function tenantRow(t: Tenant) {
  return [
    t.id.value,
    t.name,
    t.status,
    t.plan,
    t.database?.name,
    t.database?.serverId,
    t.createdAt,
  ];
}

function tenantJson(t: Tenant) {
  const s = t.toSnapshot();
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    plan: s.plan,
    data: s.data,
    database: s.database
      ? { serverId: s.database.serverId, name: s.database.name, username: s.database.username }
      : null,
    createdAt: s.createdAt,
    provisionedAt: s.provisionedAt,
  };
}

export const installCommand: Command = {
  name: 'install',
  summary: 'Crea las tablas tenancy_* en la base central y corre tus migraciones centrales',
  usage: 'tenancy install',
  async run({ out, tenancy }) {
    const t = requireDatabase(await tenancy());
    const own = await t.database.install();
    if (own.executed.length === 0) out.success('Tablas del paquete al día');
    for (const name of own.executed) out.success(`migración del paquete: ${name}`);
    const central = await t.database.migrateCentral();
    for (const name of central.executed) out.success(`migración central: ${name}`);
    out.data({ package: own.executed, central: central.executed });
    return EXIT.ok;
  },
};

export const createCommand: Command = {
  name: 'create',
  summary: 'Crea un tenant (o muchos desde un CSV) y aprovisiona su base',
  usage:
    'tenancy create <id> [--name=..] [--domain=a.com,b.com] [--plan=..] [--data=json]\n       tenancy create --from=tenants.csv [--concurrency=5] [--dry-run]',
  options: {
    name: { type: 'string' },
    domain: { type: 'string', multiple: true },
    plan: { type: 'string' },
    data: { type: 'string' },
    from: { type: 'string' },
    concurrency: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
  help: {
    domain: 'Dominio(s); el primero queda como principal',
    data: 'Datos libres en JSON, por ejemplo {"pais":"BO"}',
    from: 'CSV con columnas id,name,domain,plan,data (domain admite varios separados por |)',
    concurrency: 'Tenants creados en paralelo con --from (por defecto 5)',
    'dry-run': 'Solo valida el CSV, no crea nada',
  },
  async run({ args, out, io, tenancy, verbose }) {
    const from = stringOption(args, 'from');
    if (from) return createFromCsv(path.resolve(io.cwd, from));

    const id = requirePositional(args, 0, 'id');
    const t = await tenancy();
    const started = performance.now();
    const domain = listOption(args, 'domain');
    const name = stringOption(args, 'name');
    const plan = stringOption(args, 'plan');
    const data = parseJsonOption(stringOption(args, 'data'), '--data');
    const tenant = await t.tenants.create({
      id,
      ...(name ? { name } : {}),
      ...(plan ? { plan } : {}),
      ...(data ? { data } : {}),
      ...(domain ? { domain } : {}),
    });
    out.success(
      `tenant ${out.paint('bold', tenant.id.value)} creado (${tenant.status}${
        tenant.database ? `, base ${tenant.database.name} en ${tenant.database.serverId}` : ''
      }) ${out.paint('gray', formatDuration(performance.now() - started))}`,
    );
    out.data(tenantJson(tenant));
    return EXIT.ok;

    async function createFromCsv(file: string): Promise<number> {
      const { headers, records } = csvRecords(await readFile(file, 'utf8'));
      if (!headers.includes('id')) throw new UsageError('The CSV needs an "id" column');

      // Validación previa de todo el archivo: ids repetidos y JSON inválido.
      const problems: string[] = [];
      const seen = new Map<string, number>();
      for (const r of records) {
        const rid = r.values.id ?? '';
        if (!rid) problems.push(`línea ${r.line}: falta el id`);
        else if (seen.has(rid))
          problems.push(
            `línea ${r.line}: id "${rid}" repetido (ya está en la línea ${seen.get(rid)})`,
          );
        else seen.set(rid, r.line);
        try {
          parseJsonOption(r.values.data, 'data');
        } catch {
          problems.push(`línea ${r.line}: la columna data no es un objeto JSON`);
        }
      }
      if (problems.length > 0) {
        for (const p of problems) out.error(p);
        out.data({ valid: false, problems });
        return EXIT.usage;
      }
      if (args.values['dry-run']) {
        out.success(`${records.length} filas válidas (dry-run, no se creó nada)`);
        out.data({ valid: true, rows: records.length });
        return EXIT.ok;
      }

      const t = await tenancy();
      const concurrency = intOption(args, 'concurrency', 5);
      const result = {
        succeeded: [] as string[],
        failed: [] as { tenantId: string; error: unknown }[],
      };
      await forEachConcurrent(records, concurrency, async (r) => {
        const v = r.values;
        const started = performance.now();
        const domains = (v.domain ?? '')
          .split(/[|;]/)
          .map((d) => d.trim())
          .filter(Boolean);
        const data = parseJsonOption(v.data, 'data');
        try {
          await t.tenants.create({
            id: v.id!,
            ...(v.name ? { name: v.name } : {}),
            ...(v.plan ? { plan: v.plan } : {}),
            ...(data ? { data } : {}),
            ...(domains.length > 0 ? { domain: domains } : {}),
          });
          result.succeeded.push(v.id!);
          out.success(`${v.id}  ${out.paint('gray', formatDuration(performance.now() - started))}`);
        } catch (error) {
          result.failed.push({ tenantId: v.id!, error });
          out.error(`línea ${r.line} ${v.id}  ${out.describeError(error, verbose)}`);
        }
      });
      return summarize(out, ['creado', 'creados'], result);
    }
  },
};

export const listCommand: Command = {
  name: 'list',
  summary: 'Lista los tenants',
  usage:
    'tenancy list [--status=active,suspended] [--search=texto] [--page=1] [--per-page=50] [--deleted]',
  options: {
    status: { type: 'string' },
    search: { type: 'string' },
    page: { type: 'string' },
    'per-page': { type: 'string' },
    deleted: { type: 'boolean' },
  },
  help: { deleted: 'Incluir tenants eliminados' },
  async run({ args, out, tenancy }) {
    const statuses = listOption(args, 'status');
    for (const s of statuses ?? [])
      if (!isTenantStatus(s)) throw new UsageError(`Unknown status "${s}"`);
    const search = stringOption(args, 'search');
    const t = await tenancy();
    const page = await t.tenants.list({
      page: intOption(args, 'page', 1),
      perPage: intOption(args, 'per-page', 50),
      ...(statuses ? { status: statuses as TenantStatus[] } : {}),
      ...(search ? { search } : {}),
      ...(args.values.deleted ? { withDeleted: true } : {}),
    });
    out.table(
      ['ID', 'NOMBRE', 'ESTADO', 'PLAN', 'BASE', 'SERVIDOR', 'CREADO'],
      page.items.map(tenantRow),
    );
    const pages = Math.max(1, Math.ceil(page.total / page.perPage));
    out.line(out.paint('gray', `\n${page.total} tenants · página ${page.page} de ${pages}`));
    out.data({ ...page, items: page.items.map(tenantJson) });
    return EXIT.ok;
  },
};

export const deleteCommand: Command = {
  name: 'delete',
  summary: 'Elimina un tenant: borra su base, su usuario y sus dominios',
  usage: 'tenancy delete <id> [--force]',
  options: { force: { type: 'boolean' } },
  help: { force: 'No pedir confirmación (obligatorio fuera de una terminal)' },
  async run({ args, out, io, tenancy }) {
    const id = requirePositional(args, 0, 'id');
    const t = await tenancy();
    const tenant = await t.tenants.findOrFail(id);
    if (args.values.force !== true) {
      if (!io.isTTY) throw new UsageError('Refusing to delete without confirmation: use --force');
      out.warn(
        `Se va a borrar el tenant ${tenant.id.value}${tenant.database ? ` y su base ${tenant.database.name}` : ''}. No se puede deshacer.`,
      );
      const rl = createInterface({ input: io.stdin, output: io.stdout as NodeJS.WritableStream });
      const answer = await rl.question(`Escribe "${tenant.id.value}" para confirmar: `);
      rl.close();
      if (answer.trim() !== tenant.id.value) {
        out.error('Cancelado');
        return EXIT.failed;
      }
    }
    await t.tenants.delete(tenant.id.value);
    out.success(`tenant ${tenant.id.value} eliminado`);
    out.data({ deleted: tenant.id.value });
    return EXIT.ok;
  },
};
