import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { get } from './api';
import type { FontInfo, PlanInfo, PlanPrice, PlansResponse } from './types';

/** Planes de la configuración (`GET /plans`). Se piden una vez por sesión. */
export function usePlans(enabled = true) {
  return useQuery({
    queryKey: ['plans'],
    queryFn: () => get<PlansResponse>('/plans'),
    staleTime: 60_000,
    retry: false,
    enabled,
  });
}

const money = (value: number, currency: string) =>
  `${value.toLocaleString('es', { maximumFractionDigits: 2 })} ${currency}`;

/** "150 BOB / mes · 1.500 BOB / año", o "A consultar". */
export function formatPrice(price: PlanPrice | null | undefined): string {
  if (!price) return 'A consultar';
  const parts: string[] = [];
  if (price.monthly != null) parts.push(`${money(price.monthly, price.currency)} / mes`);
  if (price.yearly != null) parts.push(`${money(price.yearly, price.currency)} / año`);
  return parts.length > 0 ? parts.join(' · ') : 'A consultar';
}

/** Sin la llave o `null` = sin límite. */
export function formatLimit(value: number | null | undefined): string {
  return value === null || value === undefined ? 'sin límite' : String(value);
}

/** Todos los límites que nombra algún plan (y los propios de un tenant), en orden. */
export function limitNames(plans: readonly PlanInfo[], extra: readonly string[] = []): string[] {
  const names = new Set<string>();
  for (const plan of plans) for (const key of Object.keys(plan.limits)) names.add(key);
  for (const key of extra) names.add(key);
  return [...names];
}

/** Nombre de un plan para mostrar (su `label`, o el id si ya no está en la configuración). */
export function planLabel(plans: PlansResponse | undefined, id: string | null): string | null {
  if (id === null) return null;
  return plans?.plans.find((p) => p.id === id)?.label ?? id;
}

/** Solo se cargan las hojas de Google Fonts (la CSP del panel permite ese origen). */
const LOADABLE = /^https:\/\/fonts\.googleapis\.com\//;

/** Agrega al `<head>` el CSS de las fuentes (una vez cada una) para verlas en la vista previa. */
export function useFontStylesheets(fonts: readonly FontInfo[] | undefined): void {
  const urls = (fonts ?? [])
    .map((f) => f.cssUrl)
    .filter((u): u is string => !!u && LOADABLE.test(u));
  const key = urls.join('\n');
  useEffect(() => {
    const loaded = new Set(
      [...document.head.querySelectorAll<HTMLLinkElement>('link[data-font]')].map(
        (l) => l.dataset.font,
      ),
    );
    for (const href of key ? key.split('\n') : []) {
      if (loaded.has(href)) continue;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.font = href;
      document.head.appendChild(link);
    }
  }, [key]);
}
