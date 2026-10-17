import type { NotificationAudience, NotificationLevel } from '@tenancy-node/core';
import {
  EXIT,
  UsageError,
  listOption,
  requirePositional,
  stringOption,
  type Command,
} from '../command.js';

function parseDate(raw: string | undefined, name: string): Date | undefined {
  if (raw === undefined) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime()))
    throw new UsageError(`--${name} must be a date (2026-11-01 or ISO 8601)`);
  return date;
}

export const notifyCommand: Command = {
  name: 'notify',
  summary: 'Envía un aviso a todos los tenants, a algunos o a los de ciertos planes',
  usage:
    'tenancy notify "<título>" [--body=texto] [--level=info|success|warning|critical] [--tenants=a,b | --plans=pro] [--roles=ADMIN] [--link=url] [--expires=2026-11-01]',
  options: {
    body: { type: 'string' },
    level: { type: 'string' },
    tenants: { type: 'string', multiple: true },
    plans: { type: 'string', multiple: true },
    roles: { type: 'string', multiple: true },
    link: { type: 'string' },
    'link-label': { type: 'string' },
    starts: { type: 'string' },
    expires: { type: 'string' },
  },
  help: {
    tenants: 'Solo estos tenants (por defecto, todos)',
    plans: 'Solo los tenants de estos planes',
    roles: 'Solo los usuarios con estos roles (lo filtra tu app)',
    starts: 'Desde cuándo se muestra',
    expires: 'Hasta cuándo se muestra',
  },
  async run({ args, out, tenancy }) {
    const title = requirePositional(args, 0, 'título');
    const tenants = listOption(args, 'tenants');
    const plans = listOption(args, 'plans');
    if (tenants && plans) throw new UsageError('Use either --tenants or --plans, not both');
    const audience: NotificationAudience = tenants
      ? { type: 'tenants', tenants }
      : plans
        ? { type: 'plans', plans }
        : { type: 'all' };
    const link = stringOption(args, 'link');
    const startsAt = parseDate(stringOption(args, 'starts'), 'starts');
    const expiresAt = parseDate(stringOption(args, 'expires'), 'expires');
    const t = await tenancy();
    const reach = await t.notifications.reach(audience);
    const notification = await t.notifications.send({
      title,
      body: stringOption(args, 'body') ?? '',
      level: (stringOption(args, 'level') ?? 'info') as NotificationLevel,
      audience,
      roles: listOption(args, 'roles') ?? null,
      link: link
        ? {
            url: link,
            ...(stringOption(args, 'link-label')
              ? { label: stringOption(args, 'link-label')! }
              : {}),
          }
        : null,
      ...(startsAt ? { startsAt } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      createdBy: 'cli',
    });
    out.success(`aviso ${notification.id} enviado a ${reach} tenant${reach === 1 ? '' : 's'}`);
    if (t.notifications.channels.length > 0)
      out.line(out.paint('gray', `canales: ${t.notifications.channels.join(', ')}`));
    out.data({ ...notification, reach });
    return EXIT.ok;
  },
};

export const billingRunCommand: Command = {
  name: 'billing:run',
  summary:
    'Ciclo de cobro: factura los períodos por vencer, marca morosos y suspende (si está configurado)',
  usage: 'tenancy billing:run',
  async run({ out, tenancy }) {
    const t = await tenancy();
    const result = await t.billing.run();
    out.success(
      `${result.invoiced.length} facturas nuevas · ${result.pastDue.length} en mora · ${result.suspended.length} suspendidos`,
    );
    for (const id of result.suspended) out.warn(`suspendido por falta de pago: ${id}`);
    out.data(result);
    return EXIT.ok;
  },
};
