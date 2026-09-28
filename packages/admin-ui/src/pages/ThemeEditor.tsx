import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type CSSProperties } from 'react';
import { del, put } from '../api';
import { Button, Card, ErrorBox, Field, Input, Select, useToast } from '../components/ui';

type Theme = Record<string, unknown>;
const COLORS: [string, string][] = [
  ['primary', 'Primario'],
  ['secondary', 'Secundario'],
  ['accent', 'Acento'],
  ['background', 'Fondo'],
  ['text', 'Texto'],
];
const RADIUS: Record<string, string> = { none: '0', sm: '0.25rem', md: '0.5rem', lg: '1rem' };
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Mismas variables CSS que genera `/tenancy/theme.css`. */
export function themeVariables(theme: Theme): CSSProperties {
  const vars: Record<string, string> = {};
  for (const [key] of COLORS)
    if (typeof theme[key] === 'string' && HEX.test(theme[key] as string))
      vars[`--color-${key}`] = theme[key] as string;
  if (theme.font) vars['--font-main'] = `'${String(theme.font)}', system-ui, sans-serif`;
  if (theme.radius) vars['--radius'] = RADIUS[String(theme.radius)] ?? '0.5rem';
  return vars as CSSProperties;
}

export function ThemeEditor({
  tenantId,
  theme,
  canEdit,
}: {
  tenantId: string;
  theme: Theme | null;
  canEdit: boolean;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Theme>({ primary: '#2563EB', secondary: '#64748B', ...theme });
  const save = useMutation({
    mutationFn: () =>
      put(
        `/tenants/${tenantId}/theme`,
        Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== '' && v !== undefined)),
      ),
    onSuccess: () => (
      toast('Tema guardado'),
      client.invalidateQueries({ queryKey: ['tenant', tenantId] })
    ),
  });
  const reset = useMutation({
    mutationFn: () => del(`/tenants/${tenantId}/theme`),
    onSuccess: () => (
      toast('Tema por defecto'),
      setDraft({ primary: '#2563EB', secondary: '#64748B' }),
      client.invalidateQueries({ queryKey: ['tenant', tenantId] })
    ),
  });
  const set = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const vars = themeVariables(draft);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card
        title="Tema"
        actions={canEdit && <Button onClick={() => reset.mutate()}>Restablecer</Button>}
      >
        <fieldset disabled={!canEdit} className="space-y-3">
          <ErrorBox error={save.error} />
          {COLORS.map(([key, label]) => (
            <Field key={key} label={label}>
              {(id) => (
                <div className="flex gap-2">
                  <input
                    aria-label={`${label} (selector)`}
                    title={draft[key] ? String(draft[key]) : 'sin definir'}
                    type="color"
                    value={
                      HEX.test(String(draft[key] ?? '')) && String(draft[key]).length === 7
                        ? String(draft[key])
                        : '#FFFFFF'
                    }
                    onChange={(e) => set(key, e.target.value.toUpperCase())}
                    // Vacío: se atenúa para que no parezca un color elegido.
                    className={`h-8 w-10 rounded border border-line ${draft[key] ? '' : 'opacity-30'}`}
                  />
                  <Input
                    id={id}
                    value={String(draft[key] ?? '')}
                    placeholder={key === 'primary' || key === 'secondary' ? '' : 'opcional'}
                    onChange={(e) => set(key, e.target.value)}
                  />
                </div>
              )}
            </Field>
          ))}
          <Field label="Tipografía">
            {(id) => (
              <Input
                id={id}
                value={String(draft.font ?? '')}
                placeholder="Inter"
                onChange={(e) => set('font', e.target.value)}
              />
            )}
          </Field>
          <Field label="Bordes">
            {(id) => (
              <Select
                id={id}
                options={[
                  ['', 'por defecto'],
                  ['none', 'rectos'],
                  ['sm', 'poco redondeados'],
                  ['md', 'redondeados'],
                  ['lg', 'muy redondeados'],
                ]}
                value={String(draft.radius ?? '')}
                onChange={(e) => set('radius', e.target.value)}
              />
            )}
          </Field>
          <Field label="Logo" hint="Ruta en el almacenamiento del tenant o URL https.">
            {(id) => (
              <Input
                id={id}
                value={String(draft.logo ?? '')}
                onChange={(e) => set('logo', e.target.value)}
              />
            )}
          </Field>
          {canEdit && (
            <div className="flex justify-end">
              <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
                Guardar tema
              </Button>
            </div>
          )}
        </fieldset>
      </Card>
      <Card title="Vista previa">
        <div
          data-testid="theme-preview"
          style={{
            ...vars,
            background: 'var(--color-background, #fff)',
            color: 'var(--color-text, #111)',
            fontFamily: 'var(--font-main, system-ui)',
            borderRadius: 'var(--radius, 0.5rem)',
          }}
          className="space-y-3 border border-line p-4"
        >
          <p className="text-lg font-semibold" style={{ color: 'var(--color-primary)' }}>
            {tenantId}.tuapp.com
          </p>
          <p className="text-sm">Así se ve la tienda de este tenant con su tema.</p>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="preview-primary"
              style={{
                background: 'var(--color-primary)',
                color: '#fff',
                borderRadius: 'var(--radius, 0.5rem)',
              }}
              className="px-3 py-1.5 text-sm"
            >
              Comprar
            </button>
            <button
              type="button"
              style={{
                background: 'var(--color-secondary)',
                color: '#fff',
                borderRadius: 'var(--radius, 0.5rem)',
              }}
              className="px-3 py-1.5 text-sm"
            >
              Ver más
            </button>
          </div>
          {typeof draft.accent === 'string' && HEX.test(draft.accent) && (
            <p className="text-sm" style={{ color: 'var(--color-accent)' }}>
              Oferta especial
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
