import type { TenantFeatureOverrides } from '@tenancy-node/core';
import { EXIT, UsageError, listOption, requirePositional, type Command } from '../command.js';

function formatLimits(limits: Record<string, number | null>): string {
  const entries = Object.entries(limits);
  return entries.length === 0
    ? '—'
    : entries.map(([k, v]) => `${k}: ${v === null ? 'sin límite' : v}`).join(', ');
}

function formatPrice(
  price: { currency: string; monthly?: number | null; yearly?: number | null } | null,
) {
  if (!price) return 'a consultar';
  const parts = [];
  if (price.monthly !== undefined && price.monthly !== null) parts.push(`${price.monthly}/mes`);
  if (price.yearly !== undefined && price.yearly !== null) parts.push(`${price.yearly}/año`);
  return parts.length === 0 ? 'a consultar' : `${price.currency} ${parts.join(' · ')}`;
}

export const plansCommand: Command = {
  name: 'plans',
  summary: 'Lista los planes de la configuración con sus módulos, límites, precio y tenants',
  usage: 'tenancy plans',
  async run({ out, tenancy }) {
    const t = await tenancy();
    if (!t.features.enabled) {
      out.warn('No hay planes en la configuración (plans): todo tenant tiene todos los módulos.');
      out.data({ enabled: false, plans: [] });
      return EXIT.ok;
    }
    const defaultPlan = t.plans.defaultPlan;
    const withoutPlan = defaultPlan ? (await t.tenants.list({ plan: null, perPage: 1 })).total : 0;
    const plans = await Promise.all(
      t.plans.list().map(async (plan) => ({
        ...plan,
        tenants:
          (await t.tenants.list({ plan: plan.id, perPage: 1 })).total +
          (plan.id === defaultPlan ? withoutPlan : 0),
      })),
    );
    out.table(
      ['PLAN', 'NOMBRE', 'MÓDULOS', 'LÍMITES', 'PRECIO', 'TENANTS'],
      plans.map((p) => [
        `${p.id}${p.id === defaultPlan ? ' (por defecto)' : ''}${p.public ? '' : ' (oculto)'}`,
        p.label,
        p.features.join(', ') || '—',
        formatLimits(p.limits),
        formatPrice(p.price),
        p.tenants,
      ]),
    );
    out.data({ enabled: true, defaultPlan, features: t.features.catalog(), plans });
    return EXIT.ok;
  },
};

export const tenantPlanCommand: Command = {
  name: 'tenant:plan',
  summary: 'Muestra o cambia el plan de un tenant y sus módulos sueltos',
  usage:
    'tenancy tenant:plan <id> [plan] [--no-plan] [--add=modulo,...] [--remove=modulo,...] [--limit=usuarios=5] [--reset]',
  options: {
    'no-plan': { type: 'boolean' },
    add: { type: 'string', multiple: true },
    remove: { type: 'string', multiple: true },
    limit: { type: 'string', multiple: true },
    reset: { type: 'boolean' },
  },
  help: {
    'no-plan': 'Deja el tenant sin plan (usa el plan por defecto)',
    add: 'Módulos extra, además de los del plan',
    remove: 'Módulos del plan que este tenant no tiene',
    limit:
      'Límite propio (nombre=número, o nombre=none para sin límite, o nombre= para volver al del plan)',
    reset: 'Quita los módulos sueltos y límites propios antes de aplicar los demás cambios',
  },
  async run({ args, out, tenancy }) {
    const id = requirePositional(args, 0, 'id');
    const planArg = args.positionals[1];
    if (planArg !== undefined && args.values['no-plan'] === true)
      throw new UsageError('Use either <plan> or --no-plan, not both');
    const t = await tenancy();
    const tenant = await t.tenants.findOrFail(id);

    const add = listOption(args, 'add') ?? [];
    const remove = listOption(args, 'remove') ?? [];
    const limits = (listOption(args, 'limit') ?? []).map((raw) => {
      const [name, value] = raw.split('=', 2);
      if (!name || value === undefined)
        throw new UsageError(`--limit must be name=number (got "${raw}")`);
      if (value === '') return [name, undefined] as const;
      if (value === 'none') return [name, null] as const;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0)
        throw new UsageError(`--limit ${name} must be an integer >= 0, "none" or empty`);
      return [name, n] as const;
    });
    const touchesOverrides =
      add.length + remove.length + limits.length > 0 || args.values.reset === true;

    let overrides: TenantFeatureOverrides | null | undefined;
    if (touchesOverrides) {
      const current = args.values.reset === true ? {} : (tenant.features ?? {});
      const nextAdd = new Set(current.add ?? []);
      const nextRemove = new Set(current.remove ?? []);
      for (const f of add) {
        nextAdd.add(f);
        nextRemove.delete(f);
      }
      for (const f of remove) {
        nextRemove.add(f);
        nextAdd.delete(f);
      }
      const nextLimits: Record<string, number | null> = { ...current.limits };
      for (const [name, value] of limits) {
        if (value === undefined) delete nextLimits[name];
        else nextLimits[name] = value;
      }
      overrides = { add: [...nextAdd], remove: [...nextRemove], limits: nextLimits };
    }

    const plan = args.values['no-plan'] === true ? null : (planArg ?? tenant.plan);
    const changed =
      plan !== tenant.plan || overrides !== undefined
        ? await t.plans.assign(id, plan, overrides)
        : tenant;
    const resolved = t.features.of(changed);
    if (changed !== tenant) out.success(`plan de ${id} actualizado`);
    out.line(
      `Plan:    ${resolved.plan ?? '—'}${resolved.planLabel ? ` (${resolved.planLabel})` : ''}`,
    );
    if (resolved.unknownPlan)
      out.warn(
        `El plan "${resolved.unknownPlan}" no está en la configuración: ${resolved.plan ? `usa el plan por defecto (${resolved.plan})` : 'no da módulos'}.`,
      );
    out.line(`Módulos: ${resolved.features.join(', ') || '—'}`);
    out.line(`Límites: ${formatLimits(resolved.limits)}`);
    if (changed.features) {
      const f = changed.features;
      if (f.add?.length) out.line(out.paint('gray', `  + ${f.add.join(', ')}`));
      if (f.remove?.length) out.line(out.paint('gray', `  - ${f.remove.join(', ')}`));
    }
    out.data({ id, overrides: changed.features, ...resolved });
    return EXIT.ok;
  },
};
