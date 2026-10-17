import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, del, patch, post } from '../api';
import { IconPlus, IconX } from '../components/icons';
import { Button, ErrorBox, Field, Input, Modal, Textarea, cx, useToast } from '../components/ui';
import { limitNames } from '../plans';
import type { FeatureInfo, PlanInfo, PlanInput, PlanPrice, PlansResponse } from '../types';
import { suggestTenantId } from './Leads';

/** Estado del formulario de un plan (todo como texto, como lo escribe la persona). */
export interface PlanFormState {
  id: string;
  label: string;
  description: string;
  currency: string;
  monthly: string;
  yearly: string;
  highlight: boolean;
  public: boolean;
  /** "Todos los módulos": `'*'`, incluye los que se agreguen al catálogo después. */
  allFeatures: boolean;
  features: string[];
  /** Por límite: número, o `unlimited` = sin límite. Sin número ni tilde = sin límite en el plan. */
  limits: Record<string, { value: string; unlimited: boolean }>;
}

const num = (value: number | null | undefined) =>
  value === null || value === undefined ? '' : String(value);

/** Formulario a partir de un plan (o vacío para uno nuevo). */
export function planFormFrom(
  plan: PlanInfo | undefined,
  limitKeys: readonly string[],
): PlanFormState {
  const limits: PlanFormState['limits'] = {};
  for (const key of limitKeys) {
    const value = plan?.limits[key];
    limits[key] = {
      value: num(value),
      unlimited: plan !== undefined && key in plan.limits && value === null,
    };
  }
  return {
    id: plan?.id ?? '',
    label: plan?.label ?? '',
    description: plan?.description ?? '',
    currency: plan?.price?.currency ?? 'BOB',
    monthly: num(plan?.price?.monthly),
    yearly: num(plan?.price?.yearly),
    highlight: plan?.highlight ?? false,
    public: plan?.public ?? true,
    allFeatures: false,
    features: [...(plan?.features ?? [])],
    limits,
  };
}

const toNumber = (text: string): number | null => {
  const t = text.trim().replace(',', '.');
  return t === '' ? null : Number(t);
};

/** Errores de validación por campo (antes de enviar). */
export function validatePlanForm(form: PlanFormState, isNew: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (isNew && !/^[a-z][a-z0-9_.-]{0,49}$/.test(form.id))
    errors.id = 'Empieza con una letra; usa a-z, 0-9, "-", "_" o "." (hasta 50).';
  if (form.label.trim() === '') errors.label = 'El nombre es obligatorio.';
  else if (form.label.trim().length > 60) errors.label = 'Hasta 60 caracteres.';
  if (form.description.trim().length > 500) errors.description = 'Hasta 500 caracteres.';
  for (const period of ['monthly', 'yearly'] as const) {
    const value = toNumber(form[period]);
    if (value !== null && (!Number.isFinite(value) || value < 0))
      errors[period] = 'Un número mayor o igual a 0.';
  }
  if ((form.monthly.trim() || form.yearly.trim()) && !/^[A-Z]{3}$/.test(form.currency.trim()))
    errors.currency = 'Código de 3 letras (BOB, USD).';
  for (const [key, limit] of Object.entries(form.limits)) {
    if (limit.unlimited) continue;
    const value = toNumber(limit.value);
    if (value !== null && (!Number.isInteger(value) || value < 0))
      errors[`limit.${key}`] = 'Un número entero mayor o igual a 0.';
  }
  return errors;
}

/** Cuerpo completo a partir del formulario. */
export function planInputFrom(
  form: PlanFormState,
  catalog: readonly FeatureInfo[],
): Required<Omit<PlanInput, 'id'>> {
  const monthly = toNumber(form.monthly);
  const yearly = toNumber(form.yearly);
  const price: PlanPrice | null =
    monthly === null && yearly === null
      ? null
      : { currency: form.currency.trim().toUpperCase(), monthly, yearly };
  const limits: Record<string, number | null> = {};
  for (const [key, limit] of Object.entries(form.limits)) {
    if (limit.unlimited) limits[key] = null;
    else if (toNumber(limit.value) !== null) limits[key] = toNumber(limit.value);
  }
  return {
    label: form.label.trim(),
    description: form.description.trim() === '' ? null : form.description.trim(),
    price,
    // En el orden del catálogo, como los devuelve la API.
    features: form.allFeatures
      ? '*'
      : catalog.map((f) => f.id).filter((id) => form.features.includes(id)),
    limits,
    public: form.public,
    highlight: form.highlight,
  };
}

const normalizedPrice = (price: PlanPrice | null | undefined) =>
  price
    ? { currency: price.currency, monthly: price.monthly ?? null, yearly: price.yearly ?? null }
    : null;
const sortedLimits = (limits: Record<string, number | null>) =>
  JSON.stringify(Object.entries(limits).sort(([a], [b]) => a.localeCompare(b)));

/** Solo los campos que cambiaron respecto del plan (cuerpo del PATCH). */
export function planChanges(plan: PlanInfo, input: Required<Omit<PlanInput, 'id'>>): PlanInput {
  const changes: PlanInput = {};
  if (input.label !== plan.label) changes.label = input.label;
  if (input.description !== (plan.description ?? null)) changes.description = input.description;
  if (JSON.stringify(input.price) !== JSON.stringify(normalizedPrice(plan.price)))
    changes.price = input.price;
  if (input.features === '*' || JSON.stringify(input.features) !== JSON.stringify(plan.features))
    changes.features = input.features;
  if (sortedLimits(input.limits) !== sortedLimits(plan.limits)) changes.limits = input.limits;
  if (input.public !== plan.public) changes.public = input.public;
  if (input.highlight !== plan.highlight) changes.highlight = input.highlight;
  return changes;
}

/** Mensaje claro para un 409 al archivar o crear. */
export function conflictMessage(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'TENANCY_PLAN_CONFLICT') return null;
  const tenants = /(\d+) tenant/.exec(error.message);
  if (tenants)
    return `No se puede archivar: lo usan ${tenants[1]} ${tenants[1] === '1' ? 'tenant' : 'tenants'}. Cámbialos de plan primero.`;
  if (/default plan/.test(error.message)) return 'No se puede archivar: es el plan por defecto.';
  if (/archived/.test(error.message)) return 'Ya hay un plan archivado con ese id: elige otro.';
  if (/already exists/.test(error.message)) return 'Ya existe un plan con ese id: elige otro.';
  return error.message;
}

function Check({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={cx('flex items-center gap-2 text-sm', disabled && 'opacity-50')}>
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-line accent-[var(--color-brand)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}

/** Crear (sin `plan`) o editar un plan desde el panel. */
export function PlanFormModal({
  plan,
  data,
  onClose,
}: {
  plan?: PlanInfo;
  data: PlansResponse;
  onClose: () => void;
}) {
  const isNew = plan === undefined;
  const client = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<PlanFormState>(() => planFormFrom(plan, limitNames(data.plans)));
  const [idTouched, setIdTouched] = useState(false);
  const [newLimit, setNewLimit] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const errors = validatePlanForm(form, isNew);
  const input = planInputFrom(form, data.features);
  const changes = plan ? planChanges(plan, input) : null;

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? post<PlanInfo>('/plans', { id: form.id, ...input })
        : patch<PlanInfo>(`/plans/${encodeURIComponent(plan.id)}`, changes),
    onSuccess: (saved) => {
      toast(isNew ? `Plan "${saved.label}" creado` : `Plan "${saved.label}" guardado`);
      void client.invalidateQueries({ queryKey: ['plans'] });
      onClose();
    },
  });
  const set = <K extends keyof PlanFormState>(key: K, value: PlanFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setLimit = (key: string, value: Partial<PlanFormState['limits'][string]>) =>
    setForm((f) => ({ ...f, limits: { ...f.limits, [key]: { ...f.limits[key]!, ...value } } }));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    if (changes && Object.keys(changes).length === 0) return onClose();
    save.mutate();
  };
  const err = (key: string) => (submitted ? errors[key] : undefined);
  const conflict = conflictMessage(save.error);

  return (
    <Modal
      title={isNew ? 'Nuevo plan' : `Editar ${plan.label}`}
      description={
        isNew
          ? 'Se crea en el panel, sin desplegar. Los módulos salen del catálogo de la app.'
          : plan.source === 'panel'
            ? 'Plan creado en el panel.'
            : 'Plan de la configuración: los cambios se guardan aparte y se pueden restablecer.'
      }
      open
      onClose={onClose}
      size="lg"
    >
      <form
        onSubmit={onSubmit}
        className="space-y-5"
        aria-label={isNew ? 'Nuevo plan' : `Editar plan ${plan.label}`}
      >
        {conflict ? (
          <p
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger/5 px-3.5 py-2.5 text-sm text-danger"
          >
            {conflict}
          </p>
        ) : (
          <ErrorBox error={save.error} />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre" error={err('label')}>
            {(id) => (
              <Input
                id={id}
                value={form.label}
                onChange={(e) => {
                  const label = e.target.value;
                  setForm((f) => ({
                    ...f,
                    label,
                    ...(isNew && !idTouched ? { id: suggestTenantId(label) } : {}),
                  }));
                }}
              />
            )}
          </Field>
          {isNew && (
            <Field
              label="Id"
              hint="No se puede cambiar después; es el que guardan los tenants."
              error={err('id')}
            >
              {(id) => (
                <Input
                  id={id}
                  value={form.id}
                  className="font-mono"
                  onChange={(e) => (setIdTouched(true), set('id', e.target.value))}
                />
              )}
            </Field>
          )}
        </div>
        <Field label="Descripción" error={err('description')}>
          {(id) => (
            <Textarea
              id={id}
              rows={2}
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
            />
          )}
        </Field>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Precio</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Mensual" error={err('monthly')}>
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  value={form.monthly}
                  onChange={(e) => set('monthly', e.target.value)}
                />
              )}
            </Field>
            <Field label="Anual" error={err('yearly')}>
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  value={form.yearly}
                  onChange={(e) => set('yearly', e.target.value)}
                />
              )}
            </Field>
            <Field label="Moneda" error={err('currency')}>
              {(id) => (
                <Input
                  id={id}
                  maxLength={3}
                  value={form.currency}
                  onChange={(e) => set('currency', e.target.value.toUpperCase())}
                />
              )}
            </Field>
          </div>
          <p className="text-xs text-muted">Sin precios, la web comercial muestra "A consultar".</p>
        </fieldset>

        <div className="flex flex-wrap gap-6">
          <Check checked={form.highlight} onChange={(v) => set('highlight', v)}>
            Más elegido
          </Check>
          <Check checked={form.public} onChange={(v) => set('public', v)}>
            Visible en la web
          </Check>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Módulos</legend>
          <Check checked={form.allFeatures} onChange={(v) => set('allFeatures', v)}>
            Todos los módulos (también los que se agreguen después)
          </Check>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.features.map((f) => (
              <Check
                key={f.id}
                disabled={form.allFeatures}
                checked={form.allFeatures || form.features.includes(f.id)}
                onChange={(v) =>
                  set(
                    'features',
                    v ? [...form.features, f.id] : form.features.filter((x) => x !== f.id),
                  )
                }
              >
                {f.label}
              </Check>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Límites</legend>
          {Object.keys(form.limits).length === 0 && (
            <p className="text-xs text-muted">Sin límites.</p>
          )}
          {Object.entries(form.limits).map(([key, limit]) => (
            <div key={key} className="flex flex-wrap items-center gap-3">
              <span className="w-28 text-sm capitalize">{key}</span>
              <Input
                aria-label={`Límite de ${key}`}
                className="w-28"
                inputMode="numeric"
                disabled={limit.unlimited}
                value={limit.unlimited ? '' : limit.value}
                placeholder={limit.unlimited ? '∞' : ''}
                onChange={(e) => setLimit(key, { value: e.target.value })}
              />
              <Check checked={limit.unlimited} onChange={(v) => setLimit(key, { unlimited: v })}>
                Sin límite
              </Check>
              {err(`limit.${key}`) && (
                <span className="text-xs text-danger">{err(`limit.${key}`)}</span>
              )}
            </div>
          ))}
          <div className="flex gap-2">
            <Input
              aria-label="Nuevo límite"
              placeholder="Nuevo límite (ej. sucursales)"
              className="max-w-xs"
              value={newLimit}
              onChange={(e) => setNewLimit(e.target.value)}
            />
            <Button
              size="md"
              icon={<IconPlus />}
              disabled={
                !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(newLimit.trim()) ||
                newLimit.trim() in form.limits
              }
              onClick={() => {
                setForm((f) => ({
                  ...f,
                  limits: { ...f.limits, [newLimit.trim()]: { value: '', unlimited: false } },
                }));
                setNewLimit('');
              }}
            >
              Agregar
            </Button>
          </div>
        </fieldset>

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button onClick={onClose} icon={<IconX />}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            {isNew ? 'Crear plan' : 'Guardar'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Confirmación de "Restablecer a la configuración" (plan de código) o "Archivar" (plan del panel). */
export function PlanRemoveModal({ plan, onClose }: { plan: PlanInfo; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const reset = plan.source !== 'panel';
  const remove = useMutation({
    mutationFn: () =>
      del<{ id: string; result: 'reset' | 'archived' }>(`/plans/${encodeURIComponent(plan.id)}`),
    onSuccess: (result) => {
      toast(
        result.result === 'reset'
          ? `Plan "${plan.label}" restablecido`
          : `Plan "${plan.label}" archivado`,
      );
      void client.invalidateQueries({ queryKey: ['plans'] });
      onClose();
    },
  });
  const conflict = conflictMessage(remove.error);
  return (
    <Modal
      title={reset ? `Restablecer ${plan.label}` : `Archivar ${plan.label}`}
      open
      onClose={onClose}
    >
      <div className="space-y-4">
        {conflict ? (
          <p
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger/5 px-3.5 py-2.5 text-sm text-danger"
          >
            {conflict}
          </p>
        ) : (
          <ErrorBox error={remove.error} />
        )}
        <p className="text-sm">
          {reset
            ? 'Se borran los cambios hechos en el panel (nombre, precio, módulos, límites) y el plan vuelve a lo que dice la configuración de la app.'
            : 'El plan deja de ofrecerse y no se puede asignar. Los datos no se borran.'}
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
            {reset ? 'Restablecer' : 'Archivar'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
