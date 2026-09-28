import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createJiti } from 'jiti';
import { EXIT, UsageError, intOption, stringOption, type Command } from '../command.js';
import { requireDatabase } from './shared.js';

export const schemaCommand: Command = {
  name: 'schema',
  summary: 'Genera los modelos de las tablas tenancy_* para Prisma, Drizzle o TypeORM',
  usage: 'tenancy schema --prisma|--drizzle|--typeorm [--out=archivo]',
  options: {
    prisma: { type: 'boolean' },
    drizzle: { type: 'boolean' },
    typeorm: { type: 'boolean' },
    out: { type: 'string' },
  },
  help: { out: 'Escribir en este archivo en vez de mostrarlo' },
  async run({ args, out, io, tenancy }) {
    const formats = (['prisma', 'drizzle', 'typeorm'] as const).filter(
      (f) => args.values[f] === true,
    );
    if (formats.length !== 1)
      throw new UsageError('Choose exactly one of --prisma, --drizzle or --typeorm');
    const t = requireDatabase(await tenancy());
    const code = await t.database.schema(formats[0]!);
    const file = stringOption(args, 'out');
    if (file) {
      await writeFile(path.resolve(io.cwd, file), code);
      out.success(`modelos ${formats[0]} escritos en ${file}`);
    } else if (out.json) out.data({ format: formats[0], code });
    else io.stdout.write(code);
    return EXIT.ok;
  },
};

export const workerCommand: Command = {
  name: 'worker',
  summary:
    'Procesa la cola de trabajos (y los listeners en modo queue) hasta recibir SIGINT/SIGTERM',
  usage: 'tenancy worker [--concurrency=5] [--entry=src/jobs.ts]',
  options: { concurrency: { type: 'string' }, entry: { type: 'string' } },
  help: {
    concurrency: 'Trabajos en paralelo (por defecto 5)',
    entry:
      'Archivo que registra tus trabajos: export default (tenancy) => { tenancy.jobs.define(...) }',
  },
  async run({ args, out, io, tenancy, signal }) {
    const t = await tenancy();
    const entry = stringOption(args, 'entry');
    if (entry) {
      const jiti = createJiti(path.join(io.cwd, 'noop.js'), { interopDefault: true });
      const mod = (await jiti.import(path.resolve(io.cwd, entry))) as { default?: unknown };
      if (typeof mod.default === 'function')
        await (mod.default as (tenancy: unknown) => unknown)(t);
    }
    const names = t.jobs.names();
    if (names.length === 0)
      out.warn('No hay trabajos registrados: usa --entry o define los trabajos en tenancy.config');
    const concurrency = intOption(args, 'concurrency', 5);
    const worker = await t.worker({ concurrency });
    out.success(
      `worker listo (concurrencia ${concurrency}): ${names.join(', ') || 'sin trabajos'}`,
    );
    t.observability.logger.info(
      { tenantId: null, operation: 'queue.worker', jobs: names, concurrency },
      'Worker started',
    );

    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    out.info('Deteniendo el worker (esperando los trabajos en curso)...');
    await worker.close();
    out.success('worker detenido');
    return EXIT.ok;
  },
};
