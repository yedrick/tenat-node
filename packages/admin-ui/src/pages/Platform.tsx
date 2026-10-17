import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { get, patch, upload } from '../api';
import { useAuth } from '../auth';
import { IconPlus, IconX } from '../components/icons';
import {
  Button,
  Card,
  ErrorBox,
  Field,
  Input,
  PageHeader,
  Spinner,
  formatDate,
  useToast,
} from '../components/ui';
import type { PlatformInfo } from '../types';

/** Formatos que acepta `PUT /platform/logo` (el favicon además ICO). */
const IMAGE_TYPES = 'image/png,image/jpeg,image/gif,image/webp';
const HEX = /^#[0-9A-Fa-f]{6}$/;
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;

export interface PlatformForm {
  name: string;
  primary: string;
  whatsapp: string;
  email: string;
  salesNotifyTo: string[];
}

export function platformFormFrom(p: PlatformInfo): PlatformForm {
  return {
    name: p.name ?? '',
    primary: p.primary ?? '',
    whatsapp: p.contact.whatsapp ?? '',
    email: p.contact.email ?? '',
    salesNotifyTo: [...p.salesNotifyTo],
  };
}

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

/** Cuerpo del PATCH: solo lo que cambió (`null` borra un campo). */
export function platformChanges(current: PlatformInfo, form: PlatformForm) {
  const body: {
    name?: string | null;
    primary?: string | null;
    contact?: { whatsapp?: string | null; email?: string | null };
    salesNotifyTo?: string[];
  } = {};
  if (orNull(form.name) !== current.name) body.name = orNull(form.name);
  const primary = orNull(form.primary)?.toUpperCase() ?? null;
  if (primary !== (current.primary?.toUpperCase() ?? null)) body.primary = primary;
  const whatsapp = orNull(form.whatsapp)?.replace(/[\s()+.-]/g, '') ?? null;
  const contact: NonNullable<typeof body.contact> = {};
  if (whatsapp !== current.contact.whatsapp) contact.whatsapp = whatsapp;
  if (orNull(form.email) !== current.contact.email) contact.email = orNull(form.email);
  if (Object.keys(contact).length > 0) body.contact = contact;
  if (JSON.stringify(form.salesNotifyTo) !== JSON.stringify(current.salesNotifyTo))
    body.salesNotifyTo = form.salesNotifyTo;
  return body;
}

export function validatePlatform(form: PlatformForm): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.name.trim().length > 100) errors.name = 'Hasta 100 caracteres.';
  if (form.primary.trim() && !HEX.test(form.primary.trim())) errors.primary = 'Un color #RRGGBB.';
  const digits = form.whatsapp.replace(/[\s()+.-]/g, '');
  if (digits && !/^\d{8,15}$/.test(digits))
    errors.whatsapp = 'De 8 a 15 dígitos, con el código de país.';
  if (form.email.trim() && !EMAIL.test(form.email.trim())) errors.email = 'No es un email válido.';
  return errors;
}

/** Marca y contacto de la plataforma (el dominio central): web comercial, correos y avisos. */
export function Platform() {
  const query = useQuery({ queryKey: ['platform'], queryFn: () => get<PlatformInfo>('/platform') });
  if (query.isLoading)
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  if (query.error) return <ErrorBox error={query.error} />;
  return <PlatformEditor current={query.data!} />;
}

function PlatformEditor({ current }: { current: PlatformInfo }) {
  const { can } = useAuth();
  const canEdit = can('platform:write');
  const client = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(() => platformFormFrom(current));
  const [newEmail, setNewEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [assets, setAssets] = useState({
    logoUrl: current.logoUrl,
    faviconUrl: current.faviconUrl,
  });
  const logoFile = useRef<HTMLInputElement>(null);
  const faviconFile = useRef<HTMLInputElement>(null);
  useEffect(
    () => setAssets({ logoUrl: current.logoUrl, faviconUrl: current.faviconUrl }),
    [current],
  );

  const errors = validatePlatform(form);
  const changes = platformChanges(current, form);
  const refresh = (data: PlatformInfo) => client.setQueryData(['platform'], data);

  const save = useMutation({
    mutationFn: () => patch<PlatformInfo>('/platform', changes),
    onSuccess: (data) => {
      toast('Plataforma guardada');
      refresh(data);
      setForm(platformFormFrom(data));
      setSubmitted(false);
    },
  });
  const uploadAsset = useMutation({
    mutationFn: ({ kind, file }: { kind: 'logo' | 'favicon'; file: File }) =>
      upload<PlatformInfo>(`/platform/${kind}`, file),
    onSuccess: (data, { kind }) => {
      toast(kind === 'logo' ? 'Logo subido' : 'Favicon subido');
      refresh(data);
      setAssets({ logoUrl: data.logoUrl, faviconUrl: data.faviconUrl });
    },
    onSettled: () => {
      if (logoFile.current) logoFile.current.value = '';
      if (faviconFile.current) faviconFile.current.value = '';
    },
  });
  const set = <K extends keyof PlatformForm>(key: K, value: PlatformForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length > 0 || Object.keys(changes).length === 0) return;
    save.mutate();
  };
  const err = (key: string) => (submitted ? errors[key] : undefined);
  const emailOk = EMAIL.test(newEmail.trim()) && !form.salesNotifyTo.includes(newEmail.trim());
  const addEmail = () => {
    if (!emailOk || form.salesNotifyTo.length >= 20) return;
    set('salesNotifyTo', [...form.salesNotifyTo, newEmail.trim()]);
    setNewEmail('');
  };
  const primary = HEX.test(form.primary.trim()) ? form.primary.trim() : '#2563EB';
  const whatsapp = form.whatsapp.replace(/[\s()+.-]/g, '');

  return (
    <>
      <PageHeader
        title="Plataforma"
        subtitle="Marca y contacto del dominio principal: los usa la web comercial, los correos y los avisos de ventas."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <Card
          title="Marca y contacto"
          description={
            current.updatedBy || current.updatedAt
              ? `Actualizado${current.updatedBy ? ` por ${current.updatedBy}` : ''} el ${formatDate(current.updatedAt)}`
              : 'Todavía no se guardó nada: se usan los valores de la configuración.'
          }
        >
          <form onSubmit={onSubmit} aria-label="Marca de la plataforma">
            <fieldset disabled={!canEdit} className="space-y-5">
              <ErrorBox error={save.error ?? uploadAsset.error} />
              <Field label="Nombre" error={err('name')}>
                {(id) => (
                  <Input id={id} value={form.name} onChange={(e) => set('name', e.target.value)} />
                )}
              </Field>
              <Field label="Color principal" error={err('primary')}>
                {(id) => (
                  <div className="flex gap-2">
                    <input
                      type="color"
                      aria-label="Elegir color"
                      className="h-9 w-12 cursor-pointer rounded-lg border border-line bg-panel"
                      value={primary}
                      onChange={(e) => set('primary', e.target.value.toUpperCase())}
                    />
                    <Input
                      id={id}
                      className="font-mono"
                      placeholder="#0F766E"
                      value={form.primary}
                      onChange={(e) => set('primary', e.target.value)}
                    />
                  </div>
                )}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="WhatsApp"
                  hint="Con código de país, ej. 591 70000000"
                  error={err('whatsapp')}
                >
                  {(id) => (
                    <Input
                      id={id}
                      inputMode="tel"
                      value={form.whatsapp}
                      onChange={(e) => set('whatsapp', e.target.value)}
                    />
                  )}
                </Field>
                <Field label="Email de contacto" error={err('email')}>
                  {(id) => (
                    <Input
                      id={id}
                      type="email"
                      value={form.email}
                      onChange={(e) => set('email', e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Correos de ventas</legend>
                <p className="text-xs text-muted">
                  Reciben el aviso de cada solicitud de demo. Son privados: no se muestran en la
                  web.
                </p>
                <ul className="flex flex-wrap gap-2" aria-label="Correos de ventas">
                  {form.salesNotifyTo.map((email) => (
                    <li
                      key={email}
                      className="inline-flex items-center gap-1 rounded-full bg-subtle px-2.5 py-1 text-xs"
                    >
                      {email}
                      <button
                        type="button"
                        aria-label={`Quitar ${email}`}
                        className="rounded-full p-0.5 text-muted hover:text-fg"
                        onClick={() =>
                          set(
                            'salesNotifyTo',
                            form.salesNotifyTo.filter((x) => x !== email),
                          )
                        }
                      >
                        <IconX width={12} height={12} />
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <Input
                    aria-label="Nuevo correo de ventas"
                    type="email"
                    placeholder="ventas@tuapp.com"
                    className="max-w-xs"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addEmail();
                      }
                    }}
                  />
                  <Button
                    icon={<IconPlus />}
                    disabled={!emailOk || form.salesNotifyTo.length >= 20}
                    onClick={addEmail}
                  >
                    Agregar
                  </Button>
                </div>
              </fieldset>
              <div className="grid gap-4 sm:grid-cols-2">
                {(['logo', 'favicon'] as const).map((kind) => {
                  const url = kind === 'logo' ? assets.logoUrl : assets.faviconUrl;
                  const ref = kind === 'logo' ? logoFile : faviconFile;
                  return (
                    <div key={kind} className="space-y-1.5">
                      <p className="text-sm font-medium">{kind === 'logo' ? 'Logo' : 'Favicon'}</p>
                      <div className="flex items-center gap-3">
                        <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg border border-line bg-subtle">
                          {url ? (
                            <img
                              src={url}
                              alt={kind === 'logo' ? 'Logo actual' : 'Favicon actual'}
                              className="max-h-full max-w-full"
                            />
                          ) : (
                            <span className="text-xs text-muted">—</span>
                          )}
                        </div>
                        <input
                          ref={ref}
                          type="file"
                          className="hidden"
                          data-testid={`${kind}-file`}
                          accept={kind === 'favicon' ? `${IMAGE_TYPES},image/x-icon` : IMAGE_TYPES}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) uploadAsset.mutate({ kind, file });
                          }}
                        />
                        <Button
                          busy={uploadAsset.isPending && uploadAsset.variables?.kind === kind}
                          onClick={() => ref.current?.click()}
                        >
                          Subir
                        </Button>
                      </div>
                      <p className="text-xs text-muted">
                        PNG, JPEG, GIF o WebP{kind === 'favicon' ? ' (o ICO)' : ''}; sin SVG.
                      </p>
                    </div>
                  );
                })}
              </div>
              {canEdit && (
                <div className="flex justify-end gap-2 border-t border-line pt-4">
                  <Button
                    onClick={() => (setForm(platformFormFrom(current)), setSubmitted(false))}
                    disabled={Object.keys(changes).length === 0}
                  >
                    Descartar
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    busy={save.isPending}
                    disabled={Object.keys(changes).length === 0}
                  >
                    Guardar
                  </Button>
                </div>
              )}
            </fieldset>
          </form>
        </Card>

        <Card title="Vista previa" description="Así la ve la web comercial.">
          <div
            data-testid="platform-preview"
            className="overflow-hidden rounded-lg border border-line"
          >
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              {assets.logoUrl ? (
                <img src={assets.logoUrl} alt="" className="h-8 max-w-24 object-contain" />
              ) : (
                <span
                  className="h-8 w-8 rounded-md"
                  style={{ background: primary }}
                  aria-hidden="true"
                />
              )}
              <span className="font-semibold">{form.name.trim() || 'Tu plataforma'}</span>
            </div>
            <div className="space-y-3 px-4 py-5">
              <p className="text-sm text-muted">Gestiona tu clínica en un solo lugar.</p>
              <span
                className="inline-flex h-9 items-center rounded-lg px-4 text-sm font-medium text-white"
                style={{ background: primary }}
              >
                Solicitar demo
              </span>
              <ul className="space-y-1 text-sm">
                {whatsapp && (
                  <li>
                    WhatsApp:{' '}
                    <a
                      className="text-brand hover:underline"
                      href={`https://wa.me/${whatsapp}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      +{whatsapp}
                    </a>
                  </li>
                )}
                {form.email.trim() && <li>Email: {form.email.trim()}</li>}
              </ul>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
