import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type CSSProperties } from 'react';
import { del, put, upload } from '../api';
import { Button, Card, ErrorBox, Field, Input, Select, cx, useToast } from '../components/ui';
import { useFontStylesheets } from '../plans';
import type { FontInfo } from '../types';

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

/** Mismas variables CSS que genera `/tenancy/theme.css` (con la pila de respaldo de `theme.fonts`). */
export function themeVariables(theme: Theme, fonts: readonly FontInfo[] = []): CSSProperties {
  const vars: Record<string, string> = {};
  for (const [key] of COLORS)
    if (typeof theme[key] === 'string' && HEX.test(theme[key] as string))
      vars[`--color-${key}`] = theme[key] as string;
  if (theme.font)
    vars['--font-main'] =
      fonts.find((f) => f.family === theme.font)?.stack ??
      `'${String(theme.font)}', system-ui, sans-serif`;
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
  fonts = [],
}: {
  tenantId: string;
  /** Lo que ve el tenant: su tema o `theme.defaults` de la app. */
  effectiveTheme: Theme;
  defaultTheme: Theme;
  logoUrl: string | null;
  previewDomain: string | null;
  canEdit: boolean;
  /** Fuentes permitidas (`theme.fonts`). Vacío = se escribe cualquier nombre. */
  fonts?: readonly FontInfo[];
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
  const vars = themeVariables(draft, fonts);
  useFontStylesheets(fonts);

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
          {fonts.length > 0 ? (
            <FontPicker
              fonts={fonts}
              value={String(draft.font ?? '')}
              onChange={(family) => set('font', family)}
            />
          ) : (
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
          )}
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
      <Card title="Vista previa" description="Así se ve la página del tenant con este tema.">
        <ThemePreview
          vars={vars}
          draft={draft}
          title={previewDomain ?? tenantId}
          logoUrl={logo.url && draft.logo === logo.path ? logo.url : null}
        />
      </Card>
    </div>
  );
}

/** Lista de fuentes permitidas, cada una escrita en su propia fuente. */
function FontPicker({
  fonts,
  value,
  onChange,
}: {
  fonts: readonly FontInfo[];
  value: string;
  onChange: (family: string) => void;
}) {
  const options: { family: string; label: string; stack: string }[] = [
    { family: '', label: 'Por defecto', stack: 'system-ui, sans-serif' },
    ...fonts.map((f) => ({ family: f.family, label: f.label, stack: f.stack })),
  ];
  return (
    <div className="space-y-1.5">
      <p id="font-picker-label" className="text-sm font-medium">
        Tipografía
      </p>
      <div
        role="radiogroup"
        aria-labelledby="font-picker-label"
        className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto"
      >
        {options.map((f) => (
          <button
            key={f.family || 'default'}
            type="button"
            role="radio"
            aria-checked={value === f.family}
            aria-label={f.label}
            onClick={() => onChange(f.family)}
            style={{ fontFamily: f.stack }}
            className={cx(
              'rounded-lg border px-3 py-2 text-left transition-colors',
              value === f.family
                ? 'border-brand bg-brand/5 ring-2 ring-brand/20'
                : 'border-line hover:bg-subtle',
            )}
          >
            <span className="block text-lg leading-tight">Aa Bb 123</span>
            <span className="block truncate text-xs text-muted">{f.label}</span>
          </button>
        ))}
      </div>
      {value !== '' && !fonts.some((f) => f.family === value) && (
        <p className="text-xs text-warn">
          "{value}" no está en la lista de fuentes permitidas: elige otra para poder guardar.
        </p>
      )}
    </div>
  );
}

/** Mini página del tenant: cabecera, portada, botones, tarjeta y acento con su tema. */
function ThemePreview({
  vars,
  draft,
  title,
  logoUrl,
}: {
  vars: CSSProperties;
  draft: Theme;
  title: string;
  logoUrl: string | null;
}) {
  const radius = 'var(--radius, 0.5rem)';
  const hasAccent = typeof draft.accent === 'string' && HEX.test(draft.accent);
  return (
    <div
      data-testid="theme-preview"
      style={{
        ...vars,
        background: 'var(--color-background, #fff)',
        color: 'var(--color-text, #111)',
        fontFamily: 'var(--font-main, system-ui)',
        borderRadius: radius,
      }}
      className="overflow-hidden border border-line"
    >
      <div
        className="flex items-center justify-between gap-2 px-4 py-2.5"
        style={{ background: 'var(--color-primary)', color: '#fff' }}
      >
        <div className="flex min-w-0 items-center gap-2">
          {/* La URL solo se conoce para el logo guardado; uno escrito a mano se ve al guardar. */}
          {logoUrl && (
            <img
              src={logoUrl}
              alt="Logo"
              className="h-7 w-auto rounded bg-white/90 p-0.5"
              data-testid="preview-logo"
            />
          )}
          <p className="truncate text-sm font-semibold">{title}</p>
        </div>
        <span className="hidden gap-3 text-xs opacity-90 sm:flex">
          <span>Inicio</span>
          <span>Servicios</span>
          <span>Contacto</span>
        </span>
      </div>
      <div className="space-y-3 p-4">
        <p
          className="text-xl font-semibold leading-tight"
          style={{ color: 'var(--color-primary)' }}
        >
          Bienvenido
        </p>
        <p className="text-sm opacity-80">
          Así se ven los textos, los botones y las tarjetas con el tema de este tenant.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="preview-primary"
            style={{ background: 'var(--color-primary)', color: '#fff', borderRadius: radius }}
            className="px-3 py-1.5 text-sm font-medium"
          >
            Reservar
          </button>
          <button
            type="button"
            style={{
              background: 'var(--color-secondary)',
              color: '#fff',
              borderRadius: radius,
            }}
            className="px-3 py-1.5 text-sm font-medium"
          >
            Ver más
          </button>
          <button
            type="button"
            style={{
              border: '1px solid var(--color-primary)',
              color: 'var(--color-primary)',
              borderRadius: radius,
            }}
            className="bg-transparent px-3 py-1.5 text-sm font-medium"
          >
            Contacto
          </button>
        </div>
        <div
          style={{ borderRadius: radius, borderColor: 'var(--color-secondary)' }}
          className="border border-dashed p-3 text-sm"
        >
          <p className="font-semibold">Tarjeta de ejemplo</p>
          <p className="opacity-75">Bordes, separación y tipografía del tema.</p>
          {hasAccent && (
            <span
              className="mt-2 inline-block px-2 py-0.5 text-xs font-medium text-white"
              style={{ background: 'var(--color-accent)', borderRadius: radius }}
            >
              Oferta especial
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
