import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type CSSProperties } from 'react';
import { del, put, upload } from '../api';
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

/** Formatos que acepta `PUT /tenants/:id/theme/logo` (el servidor revisa el contenido real). */
const LOGO_TYPES = 'image/png,image/jpeg,image/gif,image/webp';

export function ThemeEditor({
  tenantId,
  effectiveTheme,
  defaultTheme,
  logoUrl,
  previewDomain,
  canEdit,
}: {
  tenantId: string;
  /** Lo que ve el tenant: su tema o `theme.defaults` de la app. */
  effectiveTheme: Theme;
  defaultTheme: Theme;
  logoUrl: string | null;
  previewDomain: string | null;
  canEdit: boolean;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Theme>({ ...effectiveTheme });
  const [logo, setLogo] = useState({ path: effectiveTheme.logo, url: logoUrl });
  const file = useRef<HTMLInputElement>(null);
  const save = useMutation({
    // Un campo vaciado se manda como `null` para que se borre (el servidor combina el tema).
    mutationFn: () =>
      put(
        `/tenants/${tenantId}/theme`,
        Object.fromEntries(
          Object.entries(draft).map(([k, v]) => [k, v === '' || v === undefined ? null : v]),
        ),
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
      setDraft({ ...defaultTheme }),
      client.invalidateQueries({ queryKey: ['tenant', tenantId] })
    ),
  });
  const uploadLogo = useMutation({
    mutationFn: (image: File) =>
      upload<{ theme: Theme; logoUrl: string | null }>(`/tenants/${tenantId}/theme/logo`, image),
    onSuccess: (result) => {
      toast('Logo subido');
      setDraft((d) => ({ ...d, logo: result.theme.logo }));
      setLogo({ path: result.theme.logo, url: result.logoUrl });
      void client.invalidateQueries({ queryKey: ['tenant', tenantId] });
    },
    onSettled: () => {
      if (file.current) file.current.value = '';
    },
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
          <ErrorBox error={save.error ?? uploadLogo.error} />
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
          <Field
            label="Logo"
            hint="Sube una imagen (PNG, JPEG, GIF o WebP) o escribe una ruta del almacenamiento del tenant o una URL https."
          >
            {(id) => (
              <div className="flex gap-2">
                <Input
                  id={id}
                  value={String(draft.logo ?? '')}
                  onChange={(e) => set('logo', e.target.value)}
                />
                <input
                  ref={file}
                  type="file"
                  accept={LOGO_TYPES}
                  className="hidden"
                  data-testid="logo-file"
                  onChange={(e) => {
                    const image = e.target.files?.[0];
                    if (image) uploadLogo.mutate(image);
                  }}
                />
                <Button
                  type="button"
                  busy={uploadLogo.isPending}
                  onClick={() => file.current?.click()}
                >
                  Subir
                </Button>
              </div>
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
          <div className="flex items-center gap-2">
            {/* La URL solo se conoce para el logo guardado; uno escrito a mano se ve al guardar. */}
            {logo.url && draft.logo === logo.path && (
              <img src={logo.url} alt="Logo" className="h-8 w-auto" data-testid="preview-logo" />
            )}
            <p className="text-lg font-semibold" style={{ color: 'var(--color-primary)' }}>
              {previewDomain ?? tenantId}
            </p>
          </div>
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
