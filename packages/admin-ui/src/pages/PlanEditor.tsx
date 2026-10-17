import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { patch } from '../api';
import { IconAlert } from '../components/icons';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  Input,
  Select,
  cx,
  useToast,
} from '../components/ui';
import { formatLimit, limitNames, usePlans } from '../plans';
import type { FeatureOverrides, TenantDetail } from '../types';

interface LimitDraft {
  /** `plan`: el del plan; `custom`: un número propio; `unlimited`: sin límite. */
  mode: 'plan' | 'custom' | 'unlimited';
  value: string;
}

function limitDrafts(overrides: FeatureOverrides | null | undefined): Record<string, LimitDraft> {
  const drafts: Record<string, LimitDraft> = {};
  for (const [key, value] of Object.entries(overrides?.limits ?? {}))
    drafts[key] =
      value === null ? { mode: 'unlimited', value: '' } : { mode: 'custom', value: String(value) };
  return drafts;
}

/**
 * Plan del tenant y sus módulos sueltos: cada módulo del catálogo se marca o desmarca sobre lo que
 * trae el plan (agregados / quitados), y cada límite puede usar el del plan o uno propio.
 */
export function PlanEditor({ detail, canEdit }: { detail: TenantDetail; canEdit: boolean }) {
  const t = detail.tenant;
  const client = useQueryClient();
  const toast = useToast();
  const plans = usePlans();
  const [plan, setPlan] = useState(t.plan ?? '');
  const [add, setAdd] = useState<Set<string>>(new Set(t.features?.add ?? []));
  const [remove, setRemove] = useState<Set<string>>(new Set(t.features?.remove ?? []));
  const [limits, setLimits] = useState<Record<string, LimitDraft>>(limitDrafts(t.features));

  const p = plans.data;
  const catalog = p?.features ?? [];
  const effectivePlanId = plan || p?.defaultPlan || null;
  const selected = p?.plans.find((x) => x.id === effectivePlanId);
  const inPlan = new Set(selected?.features ?? []);
  const has = (f: string) => (inPlan.has(f) ? !remove.has(f) : add.has(f));
  const effective = catalog.filter((f) => has(f.id));
  const names = limitNames(p?.plans ?? [], Object.keys(limits));

  const toggle = (f: string) => {
    const flip = (set: Set<string>) => {
      const next = new Set(set);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    };
    if (inPlan.has(f)) setRemove(flip);
    else setAdd(flip);
  };

  const body = () => {
    // Solo cuenta lo que cambia respecto del plan elegido.
    const overrides: FeatureOverrides = {};
    const added = [...add].filter((f) => !inPlan.has(f));
    const removed = [...remove].filter((f) => inPlan.has(f));
    if (added.length > 0) overrides.add = added;
    if (removed.length > 0) overrides.remove = removed;
    const own: Record<string, number | null> = {};
    for (const [key, draft] of Object.entries(limits)) {
      if (draft.mode === 'unlimited') own[key] = null;
      else if (draft.mode === 'custom' && draft.value.trim() !== '') own[key] = Number(draft.value);
    }
    if (Object.keys(own).length > 0) overrides.limits = own;
    return {
      plan: plan === '' ? null : plan,
      features: Object.keys(overrides).length > 0 ? overrides : null,
    };
  };

  const save = useMutation({
    mutationFn: () => patch(`/tenants/${encodeURIComponent(t.id)}`, body()),
    onSuccess: () => {
      toast('Plan guardado');
      void client.invalidateQueries({ queryKey: ['tenant', t.id] });
      void client.invalidateQueries({ queryKey: ['tenants'] });
      void client.invalidateQueries({ queryKey: ['plans'] });
    },
  });

  if (!p)
    return (
      <Card title="Plan y módulos">
        {plans.error ? <ErrorBox error={plans.error} /> : 'Cargando…'}
      </Card>
    );
  const unknownPlan = plan !== '' && !p.plans.some((x) => x.id === plan);

  return (
    <Card
      title="Plan y módulos"
      description="Los módulos sueltos y los límites propios se suman o reemplazan a los del plan."
    >
      <fieldset disabled={!canEdit} className="space-y-5">
        <ErrorBox error={save.error} />
        {unknownPlan && (
          <div className="flex gap-2.5 rounded-lg border border-warn/30 bg-warn/5 px-3.5 py-2.5 text-sm text-warn">
            <IconAlert className="mt-0.5 shrink-0" />
            <p>
              El plan <span className="font-mono">{t.plan}</span> ya no está en la configuración:
              este tenant solo tiene sus módulos sueltos. Elige un plan.
            </p>
          </div>
        )}
        <Field label="Plan" hint={selected?.description ?? undefined}>
          {(id) => (
            <Select
              id={id}
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              className="max-w-xs"
              options={[
                [
                  '',
                  p.defaultPlan
                    ? `Sin plan (usa ${p.plans.find((x) => x.id === p.defaultPlan)?.label ?? p.defaultPlan})`
                    : 'Sin plan',
                ],
                ...p.plans.map((x) => [x.id, x.label] as [string, string]),
                ...(unknownPlan ? [[plan, `${plan} (no configurado)`] as [string, string]] : []),
              ]}
            />
          )}
        </Field>

        <div>
          <p className="mb-2 text-sm font-medium">Módulos</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {catalog.map((f) => {
              const on = has(f.id);
              const fromPlan = inPlan.has(f.id);
              const state = fromPlan
                ? on
                  ? null
                  : ['quitado', 'danger']
                : on
                  ? ['agregado', 'ok']
                  : null;
              return (
                <li key={f.id}>
                  <label
                    className={cx(
                      'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors',
                      on ? 'border-brand/40 bg-brand/5' : 'border-line hover:bg-subtle',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(f.id)}
                      className="mt-0.5 accent-[var(--color-brand)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {f.label}
                        {fromPlan && on && <Badge tone="neutral">del plan</Badge>}
                        {state && <Badge tone={state[1]}>{state[0]}</Badge>}
                      </span>
                      {f.description && (
                        <span className="block text-xs text-muted">{f.description}</span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>

        {names.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-medium">Límites</p>
            <div className="space-y-2">
              {names.map((name) => {
                const draft = limits[name] ?? { mode: 'plan', value: '' };
                const set = (next: LimitDraft) => setLimits((l) => ({ ...l, [name]: next }));
                return (
                  <div key={name} className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="w-28 capitalize">{name}</span>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      aria-label={`Límite propio de ${name}`}
                      placeholder={`del plan: ${formatLimit(selected?.limits[name])}`}
                      disabled={draft.mode === 'unlimited'}
                      value={draft.mode === 'custom' ? draft.value : ''}
                      onChange={(e) =>
                        set(
                          e.target.value === ''
                            ? { mode: 'plan', value: '' }
                            : { mode: 'custom', value: e.target.value },
                        )
                      }
                      className="max-w-44"
                    />
                    <label className="flex items-center gap-1.5 text-xs text-muted">
                      <input
                        type="checkbox"
                        checked={draft.mode === 'unlimited'}
                        onChange={(e) =>
                          set(
                            e.target.checked
                              ? { mode: 'unlimited', value: '' }
                              : { mode: 'plan', value: '' },
                          )
                        }
                      />
                      sin límite
                    </label>
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-xs text-muted">Vacío = el límite del plan.</p>
          </div>
        )}

        <div className="rounded-lg bg-subtle px-3.5 py-3 text-sm">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">
            Lo que tendrá este tenant
          </p>
          {effective.length === 0 ? (
            <p className="text-muted">Ningún módulo.</p>
          ) : (
            <p className="flex flex-wrap gap-1.5" data-testid="effective-features">
              {effective.map((f) => (
                <Badge key={f.id} tone="info">
                  {f.label}
                </Badge>
              ))}
            </p>
          )}
        </div>

        {canEdit && (
          <div className="flex justify-end">
            <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
              Guardar plan
            </Button>
          </div>
        )}
      </fieldset>
    </Card>
  );
}
