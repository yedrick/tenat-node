import type { OutboxApi } from '@tenancy-node/outbox';
import type { CliTenancy } from '../config-loader.js';
import { EXIT, UsageError, stringOption, type Command } from '../command.js';

interface WithOutbox {
  outbox: OutboxApi;
  webhooks?: { startDispatcher(): { stop(): Promise<void> } };
}

function requireOutbox(tenancy: CliTenancy): CliTenancy & WithOutbox {
  const t = tenancy as CliTenancy & Partial<WithOutbox>;
  if (!t.outbox)
    throw new UsageError(
      'This command needs the outbox plugin (@tenancy-node/outbox) in tenancy.config',
    );
  return t as CliTenancy & WithOutbox;
}

export const outboxRelayCommand: Command = {
  name: 'outbox:relay',
  summary:
    'Publica los eventos de la outbox (y despacha los webhooks) hasta recibir SIGINT/SIGTERM',
  usage: 'tenancy outbox:relay',
  async run({ out, tenancy, signal }) {
    const t = requireOutbox(await tenancy());
    const relay = t.outbox.startRelay();
    const dispatcher = t.webhooks?.startDispatcher();
    out.success(`relay de la outbox en marcha${dispatcher ? ' (con despacho de webhooks)' : ''}`);
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    out.info('Deteniendo (se termina el lote en curso)...');
    await relay.stop();
    await dispatcher?.stop();
    out.success('relay detenido');
    return EXIT.ok;
  },
};

export const outboxStatusCommand: Command = {
  name: 'outbox:status',
  summary: 'Eventos de la outbox por estado y los que están en dead-letter',
  usage: 'tenancy outbox:status [--tenant=id]',
  options: { tenant: { type: 'string' } },
  help: { tenant: 'Mostrar solo el dead-letter de este tenant' },
  async run({ args, out, tenancy }) {
    const t = requireOutbox(await tenancy());
    const stats = await t.outbox.stats();
    const tenant = stringOption(args, 'tenant');
    const failed = await t.outbox.failed({ limit: 50, ...(tenant ? { tenantId: tenant } : {}) });
    out.pairs(Object.entries(stats));
    out.line();
    if (failed.length > 0) {
      out.line(out.paint('bold', 'Dead-letter'));
      out.table(
        ['ID', 'EVENTO', 'TENANT', 'DESTINO', 'INTENTOS', 'ÚLTIMO ERROR'],
        failed.map((f) => [f.id, f.type, f.tenantId, f.destination, f.attempts, f.lastError]),
      );
    }
    out.data({ stats, failed });
    return stats.failed > 0 ? EXIT.failed : EXIT.ok;
  },
};

export const outboxRetryCommand: Command = {
  name: 'outbox:retry',
  summary: 'Vuelve a poner en cola eventos del dead-letter',
  usage: 'tenancy outbox:retry --id=<id> | --tenant=<id> | --all',
  options: { id: { type: 'string' }, tenant: { type: 'string' }, all: { type: 'boolean' } },
  async run({ args, out, tenancy }) {
    const id = stringOption(args, 'id');
    const tenant = stringOption(args, 'tenant');
    const all = args.values.all === true;
    if ([id, tenant, all || undefined].filter(Boolean).length !== 1)
      throw new UsageError('Use exactly one of --id, --tenant or --all');
    const t = requireOutbox(await tenancy());
    const count = await t.outbox.retry(id ? { id } : tenant ? { tenantId: tenant } : 'all');
    out.success(`${count} ${count === 1 ? 'evento vuelve' : 'eventos vuelven'} a la cola`);
    out.data({ retried: count });
    return EXIT.ok;
  },
};
