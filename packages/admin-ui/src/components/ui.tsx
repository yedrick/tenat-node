import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { ApiError } from '../api';
import { IconAlert, IconCheck, IconCopy, IconX } from './icons';

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('es', { dateStyle: 'short', timeStyle: 'medium' });
}

const RELATIVE = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** "hace 3 días". La fecha exacta queda en el `title`. */
export function RelativeTime({ value }: { value: string | Date | null | undefined }) {
  if (!value) return <span className="text-muted">—</span>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="text-muted">—</span>;
  const seconds = (date.getTime() - Date.now()) / 1000;
  const [unit, size] = UNITS.find(([, s]) => Math.abs(seconds) >= s) ?? ['second', 1];
  return (
    <time dateTime={date.toISOString()} title={formatDate(date)}>
      {Math.abs(seconds) < 45 ? 'recién' : RELATIVE.format(Math.round(seconds / size), unit)}
    </time>
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  variant = 'secondary',
  size = 'md',
  busy,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'md';
  busy?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || busy}
      className={cx(
        'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-brand text-brand-fg shadow-sm hover:bg-brand/90',
        variant === 'secondary' &&
          'border border-line bg-panel text-fg shadow-sm hover:border-muted/40 hover:bg-subtle',
        variant === 'danger' && 'bg-danger text-white shadow-sm hover:bg-danger/90',
        variant === 'ghost' && 'text-muted hover:bg-subtle hover:text-fg',
        className,
      )}
    >
      {busy ? <Spinner small /> : icon}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
      </label>
      {children(id)}
      {hint && !error && <p className="text-xs leading-relaxed text-muted">{hint}</p>}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const CONTROL =
  'w-full rounded-lg border border-line bg-panel px-3 text-sm text-fg shadow-sm outline-none transition placeholder:text-muted/70 focus:border-brand focus:ring-3 focus:ring-brand/15 disabled:cursor-not-allowed disabled:bg-subtle disabled:text-muted';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(CONTROL, 'h-9', props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={4} {...props} className={cx(CONTROL, 'py-2', props.className)} />;
}

export function Select({
  options,
  ...props
}: InputHTMLAttributes<HTMLSelectElement> & { options: readonly (string | [string, string])[] }) {
  return (
    <select {...(props as object)} className={cx(CONTROL, 'h-9 pr-8', props.className)}>
      {options.map((o) => {
        const [value, label] = typeof o === 'string' ? [o, o] : o;
        return (
          <option key={value} value={value}>
            {label}
          </option>
        );
      })}
    </select>
  );
}

type Tone = 'ok' | 'info' | 'warn' | 'danger' | 'neutral';

const TONE_BY_STATUS: Record<string, Tone> = {
  active: 'ok',
  success: 'ok',
  completed: 'ok',
  published: 'ok',
  closed: 'ok',
  provisioning: 'info',
  running: 'info',
  pending: 'info',
  processing: 'info',
  maintenance: 'warn',
  half_open: 'warn',
  skipped: 'neutral',
  suspended: 'danger',
  failed: 'danger',
  dead: 'danger',
  open: 'danger',
  deleting: 'danger',
};

const TONE_CLASSES: Record<Tone, string> = {
  ok: 'bg-ok/10 text-ok ring-ok/20',
  info: 'bg-info/10 text-info ring-info/20',
  warn: 'bg-warn/10 text-warn ring-warn/25',
  danger: 'bg-danger/10 text-danger ring-danger/20',
  neutral: 'bg-muted/10 text-muted ring-muted/20',
};

export function Badge({
  children,
  tone,
  dot,
}: {
  children: ReactNode;
  /** Un estado (`active`, `failed`...) o un tono (`ok`, `warn`...). */
  tone?: string;
  dot?: boolean;
}) {
  const key = tone ?? String(children);
  const resolved: Tone = (TONE_CLASSES as Record<string, string>)[key]
    ? (key as Tone)
    : (TONE_BY_STATUS[key] ?? 'neutral');
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONE_CLASSES[resolved],
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Activo',
  provisioning: 'Aprovisionando',
  maintenance: 'Mantenimiento',
  suspended: 'Suspendido',
  failed: 'Con fallas',
  deleting: 'Eliminando',
};

/** Estado de un tenant con su color y en castellano. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={status} dot>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

const STEP_LABELS: Record<string, string> = {
  completed: 'Listo',
  skipped: 'Omitido',
  running: 'En curso',
  pending: 'Pendiente',
  failed: 'Falló',
};

/** Estado de un paso del aprovisionamiento, en castellano. */
export function StepBadge({ status }: { status: string }) {
  return <Badge tone={status}>{STEP_LABELS[status] ?? status}</Badge>;
}

const AVATAR_COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#db2777', '#7c3aed', '#2563eb'];

/** Iniciales sobre un color (el del tema del tenant, o uno estable según el nombre). */
export function Avatar({
  name,
  color,
  src,
  size = 'md',
}: {
  name: string;
  color?: string | undefined;
  src?: string | null | undefined;
  size?: 'sm' | 'md' | 'lg';
}) {
  const [broken, setBroken] = useState(false);
  const initials =
    name
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?';
  const hash = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const background =
    color && /^#[0-9a-f]{6}$/i.test(color) ? color : AVATAR_COLORS[hash % AVATAR_COLORS.length];
  const box = { sm: 'h-7 w-7 text-[11px]', md: 'h-9 w-9 text-xs', lg: 'h-12 w-12 text-base' }[size];
  if (src && !broken)
    return (
      <img
        src={src}
        alt=""
        onError={() => setBroken(true)}
        className={cx(box, 'shrink-0 rounded-lg border border-line bg-panel object-contain p-0.5')}
      />
    );
  return (
    <span
      aria-hidden="true"
      style={{ background }}
      className={cx(
        box,
        'inline-flex shrink-0 items-center justify-center rounded-lg font-semibold text-white',
      )}
    >
      {initials}
    </span>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
  flush,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Sin relleno interno (para tablas de borde a borde). */
  flush?: boolean;
}) {
  return (
    <section
      className={cx(
        'rounded-xl border border-line bg-panel shadow-[var(--shadow-card)]',
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          <div className="flex flex-wrap gap-2">{actions}</div>
        </header>
      )}
      <div className={flush ? '' : 'p-5'}>{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  leading,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {leading}
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return (
    <span
      role="status"
      aria-label="Cargando"
      className={cx(
        'inline-block animate-spin rounded-full border-2 border-current border-t-transparent',
        small ? 'h-3.5 w-3.5' : 'h-5 w-5 text-brand',
      )}
    />
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : 'ERROR';
  const message = error instanceof Error ? error.message : String(error);
  const details =
    error instanceof ApiError && Array.isArray(error.details)
      ? (error.details as { path: string; message: string }[])
      : [];
  return (
    <div
      role="alert"
      className="flex gap-2.5 rounded-lg border border-danger/25 bg-danger/5 px-3.5 py-2.5 text-sm text-danger"
    >
      <IconAlert className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <strong className="font-mono text-xs">{code}</strong> {message}
        {details.length > 0 && (
          <ul className="mt-1 list-disc pl-5 text-xs">
            {details.map((d) => (
              <li key={d.path + d.message}>
                {d.path ? `${d.path}: ` : ''}
                {d.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function EmptyState({
  children,
  icon,
  action,
}: {
  children: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      {icon && (
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-subtle text-muted ring-1 ring-line">
          {icon}
        </span>
      )}
      <p className="text-sm text-muted">{children}</p>
      {action}
    </div>
  );
}

export function DataTable<T>({
  data,
  columns,
  empty = 'Sin resultados',
  emptyIcon,
  onRowClick,
}: {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  empty?: string;
  emptyIcon?: ReactNode;
  onRowClick?: (row: T) => void;
}) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
  if (data.length === 0) return <EmptyState icon={emptyIcon}>{empty}</EmptyState>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-subtle text-xs font-medium text-muted">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th
                  key={header.id}
                  className="whitespace-nowrap border-b border-line px-4 py-2.5 font-medium first:pl-5 last:pr-5"
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody className="divide-y divide-line">
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              className={cx('transition-colors', onRowClick && 'cursor-pointer hover:bg-subtle')}
              onClick={onRowClick ? () => onRowClick(row.original) : undefined}
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-4 py-3 align-middle first:pl-5 last:pr-5">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: readonly [string, string][];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div role="tablist" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={active === key}
          onClick={() => onChange(key)}
          className={cx(
            '-mb-px whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1.5 text-sm transition-colors',
            active === key
              ? 'border-brand font-medium text-fg'
              : 'border-transparent text-muted hover:border-line hover:text-fg',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  title,
  description,
  open,
  onClose,
  children,
  size = 'md',
}: {
  title: string;
  description?: ReactNode;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: 'md' | 'lg';
}) {
  const dialog = useRef<HTMLDivElement>(null);
  // `onClose` suele ser una función nueva en cada render: se lee de una ref para que el efecto
  // corra solo al abrir (si no, el foco volvería al primer campo con cada tecla).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', onKey);
    // El foco entra al diálogo y vuelve a donde estaba al cerrar.
    const first = dialog.current?.querySelector<HTMLElement>(
      'input:not([type=hidden]):not([disabled]), select, textarea, button:not([aria-label=Cerrar])',
    );
    first?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/50 p-4 backdrop-blur-[2px] sm:items-center"
      onClick={onClose}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          'my-8 w-full rounded-xl border border-line bg-panel shadow-[var(--shadow-pop)]',
          size === 'lg' ? 'max-w-2xl' : 'max-w-lg',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          <button
            type="button"
            aria-label="Cerrar"
            onClick={onClose}
            className="rounded-md p-1 text-muted hover:bg-subtle hover:text-fg"
          >
            <IconX />
          </button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/** Copia un texto al portapapeles y lo confirma un momento. */
export function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      icon={done ? <IconCheck /> : <IconCopy />}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? 'Copiado' : label}
    </Button>
  );
}

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}
const ToastContext = createContext<(text: string, tone?: 'ok' | 'error') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="fixed bottom-4 right-4 z-[60] space-y-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="flex items-center gap-2.5 rounded-lg border border-line bg-panel px-4 py-2.5 text-sm text-fg shadow-[var(--shadow-pop)]"
          >
            <span
              className={cx(
                'flex h-5 w-5 items-center justify-center rounded-full text-white',
                t.tone === 'ok' ? 'bg-ok' : 'bg-danger',
              )}
            >
              {t.tone === 'ok' ? (
                <IconCheck width={12} height={12} />
              ) : (
                <IconX width={12} height={12} />
              )}
            </span>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
