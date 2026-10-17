import { useState } from 'react';
import { useAuth } from '../auth';
import {
  IconAlert,
  IconArchive,
  IconCheck,
  IconLayers,
  IconPencil,
  IconPlus,
  IconUndo,
} from '../components/icons';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  PageHeader,
  Spinner,
  cx,
  formatDate,
} from '../components/ui';
import { formatLimit, formatPrice, limitNames, usePlans } from '../plans';
import { Link } from '../router';
import type { PlanInfo } from '../types';
import { PlanFormModal, PlanRemoveModal } from './PlanForm';

/** Etiquetas de origen y estado de un plan. */
function PlanBadges({ plan }: { plan: PlanInfo }) {
  return (
    <>
      {plan.source === 'panel' ? (
        <Badge tone="info">Creado en el panel</Badge>
      ) : (
        <Badge tone="neutral">Configuración</Badge>
      )}
      {plan.customized && <Badge tone="warn">Modificado</Badge>}
      {plan.archived && <Badge tone="neutral">Archivado</Badge>}
    </>
  );
}

/** Planes: precio, módulos, límites y tenants de cada uno; se editan sin desplegar. */
export function Plans() {
  const plans = usePlans();
  const { can } = useAuth();
  const canWrite = can('plans:write');
  const [editing, setEditing] = useState<PlanInfo | 'new' | null>(null);
  const [removing, setRemoving] = useState<PlanInfo | null>(null);
  if (plans.isLoading)
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  if (plans.error) return <ErrorBox error={plans.error} />;
  const data = plans.data!;
  const active = data.plans.filter((plan) => !plan.archived);
  const archived = data.plans.filter((plan) => plan.archived);
  const p = { ...data, plans: active };
  const limits = limitNames(active);
  return (
    <>
      <PageHeader
        title="Planes"
        subtitle="Los módulos salen de la configuración de la app; nombres, precios, módulos y límites de cada plan se editan aquí sin desplegar."
        actions={
          canWrite && data.features.length > 0 ? (
            <Button variant="primary" icon={<IconPlus />} onClick={() => setEditing('new')}>
              Nuevo plan
            </Button>
          ) : undefined
        }
      />
      {editing && (
        <PlanFormModal
          data={data}
          {...(editing === 'new' ? {} : { plan: editing })}
          onClose={() => setEditing(null)}
        />
      )}
      {removing && <PlanRemoveModal plan={removing} onClose={() => setRemoving(null)} />}
      {!p.enabled && (
        <Card>
          <EmptyState icon={<IconLayers />}>
            El control de módulos está apagado: la configuración no tiene <code>plans</code>, así
            que todos los tenants tienen todos los módulos. Crear un plan lo activa.
          </EmptyState>
        </Card>
      )}
      {p.unknown.length > 0 && (
        <div
          role="alert"
          className="mb-6 flex gap-2.5 rounded-lg border border-warn/30 bg-warn/5 px-4 py-3 text-sm text-warn"
        >
          <IconAlert className="mt-0.5 shrink-0" />
          <p>
            Hay tenants con planes que ya no están en la configuración (no tienen módulos del plan):{' '}
            {p.unknown.map((u, i) => (
              <span key={u.plan}>
                {i > 0 && ', '}
                <Link to={`/tenants?plan=${encodeURIComponent(u.plan)}`} className="underline">
                  {u.plan} ({u.tenants})
                </Link>
              </span>
            ))}
            .
          </p>
        </div>
      )}
      {p.enabled && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {p.plans.map((plan) => (
              <section
                key={plan.id}
                aria-label={`Plan ${plan.label}`}
                className={cx(
                  'flex flex-col rounded-xl border bg-panel p-5 shadow-[var(--shadow-card)]',
                  plan.highlight ? 'border-brand ring-1 ring-brand/30' : 'border-line',
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold">{plan.label}</h2>
                  <span className="font-mono text-xs text-muted">{plan.id}</span>
                  {plan.highlight && <Badge tone="info">Destacado</Badge>}
                  {!plan.public && <Badge tone="neutral">Oculto en la web</Badge>}
                  {plan.id === p.defaultPlan && <Badge tone="ok">Por defecto</Badge>}
                  <PlanBadges plan={plan} />
                </div>
                {plan.description && <p className="mt-1 text-sm text-muted">{plan.description}</p>}
                <p className="mt-3 text-lg font-semibold tabular-nums">{formatPrice(plan.price)}</p>
                <ul className="mt-3 flex-1 space-y-1 text-sm">
                  {p.features
                    .filter((f) => plan.features.includes(f.id))
                    .map((f) => (
                      <li key={f.id} className="flex items-center gap-2">
                        <IconCheck className="shrink-0 text-ok" /> {f.label}
                      </li>
                    ))}
                </ul>
                <Link
                  to={`/tenants?plan=${encodeURIComponent(plan.id)}`}
                  className="mt-4 text-sm font-medium text-brand hover:underline"
                >
                  {plan.tenants} {plan.tenants === 1 ? 'tenant' : 'tenants'} →
                </Link>
                {plan.updatedBy && (
                  <p className="mt-2 text-xs text-muted">
                    Modificado por {plan.updatedBy} el {formatDate(plan.updatedAt)}
                  </p>
                )}
                {canWrite && (
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
                    <Button size="sm" icon={<IconPencil />} onClick={() => setEditing(plan)}>
                      Editar
                    </Button>
                    {plan.customized && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<IconUndo />}
                        onClick={() => setRemoving(plan)}
                      >
                        Restablecer a la configuración
                      </Button>
                    )}
                    {plan.source === 'panel' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<IconArchive />}
                        onClick={() => setRemoving(plan)}
                      >
                        Archivar
                      </Button>
                    )}
                  </div>
                )}
              </section>
            ))}
          </div>

          <Card title="Comparativa" className="mt-6" flush>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-subtle text-xs font-medium text-muted">
                  <tr>
                    <th className="border-b border-line px-4 py-2.5 pl-5 font-medium">Módulo</th>
                    {p.plans.map((plan) => (
                      <th
                        key={plan.id}
                        className="border-b border-line px-4 py-2.5 text-center font-medium last:pr-5"
                      >
                        {plan.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {p.features.map((f) => (
                    <tr key={f.id}>
                      <td className="px-4 py-2.5 pl-5">
                        <p>{f.label}</p>
                        {f.description && <p className="text-xs text-muted">{f.description}</p>}
                      </td>
                      {p.plans.map((plan) => (
                        <td key={plan.id} className="px-4 py-2.5 text-center last:pr-5">
                          {plan.features.includes(f.id) ? (
                            <IconCheck className="inline text-ok" aria-label="incluido" />
                          ) : (
                            <span className="text-muted" aria-label="no incluido">
                              —
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {limits.map((name) => (
                    <tr key={name} className="bg-subtle/40">
                      <td className="px-4 py-2.5 pl-5 capitalize">Límite: {name}</td>
                      {p.plans.map((plan) => (
                        <td
                          key={plan.id}
                          className="px-4 py-2.5 text-center tabular-nums last:pr-5"
                        >
                          {formatLimit(plan.limits[name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <td className="px-4 py-2.5 pl-5 font-medium">Tenants</td>
                    {p.plans.map((plan) => (
                      <td key={plan.id} className="px-4 py-2.5 text-center last:pr-5">
                        <Link
                          to={`/tenants?plan=${encodeURIComponent(plan.id)}`}
                          className="font-medium text-brand hover:underline"
                        >
                          {plan.tenants}
                        </Link>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
          {p.withoutPlan > 0 && (
            <p className="mt-4 text-sm text-muted">
              <Link to="/tenants?plan=" className="text-brand hover:underline">
                {p.withoutPlan} {p.withoutPlan === 1 ? 'tenant' : 'tenants'} sin plan
              </Link>{' '}
              (no hay plan por defecto: solo tienen sus módulos sueltos).
            </p>
          )}
        </>
      )}
      {archived.length > 0 && (
        <details className="mt-6 rounded-xl border border-line bg-panel px-5 py-3.5">
          <summary className="cursor-pointer text-sm font-semibold">
            Archivados ({archived.length})
          </summary>
          <ul className="mt-3 divide-y divide-line">
            {archived.map((plan) => (
              <li
                key={plan.id}
                className="flex flex-wrap items-center gap-2 py-2.5 text-sm"
                aria-label={`Plan archivado ${plan.label}`}
              >
                <span className="font-medium">{plan.label}</span>
                <span className="font-mono text-xs text-muted">{plan.id}</span>
                <PlanBadges plan={plan} />
                <span className="text-muted">{formatPrice(plan.price)}</span>
                {plan.updatedBy && (
                  <span className="text-xs text-muted">
                    · por {plan.updatedBy} el {formatDate(plan.updatedAt)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
