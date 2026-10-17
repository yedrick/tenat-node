import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { followProgress, patch, post, type ProgressEvent } from '../api';
import { useAuth } from '../auth';
import { DataEditor, dataFromRows, rowsFromData, type DataRow } from '../components/DataEditor';
import {
  Button,
  ErrorBox,
  Field,
  Input,
  Modal,
  Select,
  StepBadge,
  useToast,
} from '../components/ui';
import { usePlans } from '../plans';
import type { Lead, TenantField } from '../types';
import { navigate } from '../router';

/** Valores iniciales (por ejemplo, desde una solicitud de la web comercial). */
export interface NewTenantInitial {
  id?: string;
  name?: string;
  plan?: string;
  /** Datos libres de `tenant.data`. */
  data?: Record<string, string>;
  /** Para los campos declarados de tipo `email` y `tel`. */
  email?: string | null;
  phone?: string | null;
}

interface StepState {
  step: string;
  status: string;
  durationMs?: number | null;
  error?: string | null;
}

const STEP_LABELS: Record<string, string> = {
  placement: 'Elegir servidor',
  createDatabase: 'Crear base de datos',
  createUser: 'Crear usuario de la base',
  migrate: 'Migraciones',
  seed: 'Datos iniciales',
  cleanup: 'Limpieza',
};

/** Valor de un campo declarado, con el tipo que espera la app. */
function fieldValue(field: TenantField, raw: string): unknown {
  return field.type === 'number' ? Number(raw) : raw.trim();
}

export function NewTenant({
  open,
  onClose,
  initial,
  leadId,
  onConverted,
}: {
  open: boolean;
  onClose: () => void;
  initial?: NewTenantInitial;
  /** Solicitud de la que sale el tenant: al crearlo queda como convertida. */
  leadId?: number;
  /** La solicitud quedó convertida (con el tenant creado). */
  onConverted?: (lead: Lead) => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const plans = usePlans(open);
  const planOptions = plans.data?.enabled ? plans.data : undefined;
  const fields = session?.config?.tenantFields ?? [];
  const central = session?.config?.centralDomains[0] ?? 'tuapp.com';
  const [form, setForm] = useState({ id: '', name: '', domain: '', plan: '' });
  const [declared, setDeclared] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState<DataRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [final, setFinal] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);
  // Al abrir con valores iniciales (desde una solicitud), se cargan en el formulario.
  useEffect(() => {
    if (!open || !initial) return;
    setForm({
      id: initial.id ?? '',
      name: initial.name ?? '',
      domain: '',
      plan: initial.plan ?? '',
    });
    const prefilled: Record<string, string> = {};
    const used = new Set<string>();
    for (const field of fields) {
      const value =
        field.type === 'email' ? initial.email : field.type === 'tel' ? initial.phone : null;
      if (value) prefilled[field.key] = value;
    }
    // Lo que ya va en un campo declarado no se repite en los datos libres.
    for (const [key, value] of Object.entries(initial.data ?? {}))
      if (Object.values(prefilled).includes(value)) used.add(key);
    setDeclared(prefilled);
    setExtra(rowsFromData(initial.data ?? {}, used));
  }, [open]);
  const reset = () => {
    stop.current?.();
    setForm({ id: '', name: '', domain: '', plan: '' });
    setDeclared({});
    setExtra([]);
    setCreatingId(null);
    setSteps([]);
    setFinal(null);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Primero los datos libres; los campos declarados por la app tienen prioridad.
      const data = dataFromRows(extra);
      for (const field of fields) {
        const raw = declared[field.key] ?? '';
        if (raw.trim() !== '') data[field.key] = fieldValue(field, raw);
      }
      await post('/tenants', {
        id: form.id.trim(),
        ...(Object.keys(data).length > 0 ? { data } : {}),
        ...(form.name ? { name: form.name } : {}),
        ...(form.domain
          ? {
              domain: form.domain
                .split(',')
                .map((d) => d.trim())
                .filter(Boolean),
            }
          : {}),
        ...(form.plan ? { plan: form.plan } : {}),
      });
      const id = form.id.trim();
      setCreatingId(id);
      if (leadId !== undefined) {
        try {
          onConverted?.(await patch(`/leads/${leadId}`, { status: 'converted', tenantId: id }));
          void client.invalidateQueries({ queryKey: ['leads'] });
        } catch (e) {
          toast(
            `El tenant se crea, pero la solicitud no se marcó como convertida: ${e instanceof Error ? e.message : String(e)}`,
            'error',
          );
        }
      }
      // Progreso en vivo (SSE): un paso a la vez hasta 'done'
      stop.current = followProgress(id, (e: ProgressEvent) => {
        if (e.event === 'step') {
          setSteps((current) => {
            const others = current.filter((s) => s.step !== e.data.step);
            return [
              ...others,
              {
                step: e.data.step!,
                status: e.data.status,
                durationMs: e.data.durationMs ?? null,
                error: e.data.error ?? null,
              },
            ];
          });
        }
        if (e.event === 'done') {
          setFinal(e.data.status);
          void client.invalidateQueries({ queryKey: ['tenants'] });
        }
      });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    reset();
    onClose();
  };

  return (
    <Modal
      title={creatingId ? `Creando ${creatingId}` : 'Nuevo tenant'}
      open={open}
      onClose={close}
    >
      {!creatingId ? (
        <form onSubmit={submit} className="space-y-3">
          <ErrorBox error={error} />
          <Field
            label="Id"
            hint="2 a 40 caracteres: a-z, 0-9, guion y guion bajo. Se usa en el subdominio y en el nombre de la base."
          >
            {(id) => (
              <Input
                id={id}
                required
                pattern="[a-z0-9][a-z0-9_\-]{1,39}"
                value={form.id}
                onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })}
              />
            )}
          </Field>
          <Field label="Nombre">
            {(id) => (
              <Input
                id={id}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Dominios" hint="Separados por coma. El primero queda como principal.">
            {(id) => (
              <Input
                id={id}
                value={form.domain}
                placeholder={`bolivar.${central}`}
                onChange={(e) => setForm({ ...form, domain: e.target.value })}
              />
            )}
          </Field>
          <Field label="Plan">
            {(id) =>
              planOptions ? (
                <Select
                  id={id}
                  value={form.plan}
                  onChange={(e) => setForm({ ...form, plan: e.target.value })}
                  options={[
                    [
                      '',
                      planOptions.defaultPlan
                        ? `Sin plan (usa ${planOptions.plans.find((p) => p.id === planOptions.defaultPlan)?.label ?? planOptions.defaultPlan})`
                        : 'Sin plan',
                    ],
                    ...planOptions.plans.map((p) => [p.id, p.label] as [string, string]),
                  ]}
                />
              ) : (
                <Input
                  id={id}
                  value={form.plan}
                  onChange={(e) => setForm({ ...form, plan: e.target.value })}
                />
              )
            }
          </Field>
          {fields.map((field) => (
            <Field key={field.key} label={field.label} hint={field.hint}>
              {(id) => (
                <Input
                  id={id}
                  type={field.type ?? 'text'}
                  required={field.required}
                  placeholder={field.placeholder}
                  value={declared[field.key] ?? ''}
                  onChange={(e) => setDeclared({ ...declared, [field.key]: e.target.value })}
                />
              )}
            </Field>
          ))}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Datos adicionales</legend>
            <p className="text-xs text-muted">
              Se guardan en <code>tenant.data</code> y los recibe el seed.
            </p>
            <DataEditor rows={extra} onChange={setExtra} />
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={close}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" busy={busy}>
              Crear
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <ol aria-label="Progreso" className="space-y-2">
            {steps.length === 0 && (
              <li className="text-sm text-muted">Esperando al aprovisionamiento…</li>
            )}
            {steps.map((s) => (
              <li key={s.step} className="flex items-start justify-between gap-2 text-sm">
                <span>{STEP_LABELS[s.step] ?? s.step}</span>
                <span className="text-right">
                  <StepBadge status={s.status} />
                  {s.durationMs != null && (
                    <span className="ml-1 text-xs text-muted">{s.durationMs} ms</span>
                  )}
                  {s.error && <p className="text-xs text-danger">{s.error}</p>}
                </span>
              </li>
            ))}
          </ol>
          {final && (
            <div
              role="status"
              className={`rounded-md px-3 py-2 text-sm ${final === 'active' ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger'}`}
            >
              {final === 'active'
                ? 'El tenant quedó activo.'
                : 'El aprovisionamiento falló. Revisa el paso con error y reintenta desde el detalle.'}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cerrar</Button>
            {final && (
              <Button
                variant="primary"
                onClick={() => (close(), navigate(`/tenants/${creatingId}`))}
              >
                Ver tenant
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
