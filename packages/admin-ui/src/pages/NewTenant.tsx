import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { followProgress, post, type ProgressEvent } from '../api';
import { Badge, Button, ErrorBox, Field, Input, Modal } from '../components/ui';
import { navigate } from '../router';

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

export function NewTenant({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const [form, setForm] = useState({ id: '', name: '', domain: '', plan: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [final, setFinal] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);
  const reset = () => {
    stop.current?.();
    setForm({ id: '', name: '', domain: '', plan: '' });
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
      await post('/tenants', {
        id: form.id.trim(),
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
                placeholder="bolivar.tuapp.com"
                onChange={(e) => setForm({ ...form, domain: e.target.value })}
              />
            )}
          </Field>
          <Field label="Plan">
            {(id) => (
              <Input
                id={id}
                value={form.plan}
                onChange={(e) => setForm({ ...form, plan: e.target.value })}
              />
            )}
          </Field>
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
                  <Badge>{s.status}</Badge>
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
