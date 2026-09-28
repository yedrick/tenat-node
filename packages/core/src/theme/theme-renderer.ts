import { createHash } from 'node:crypto';
import type { Theme, ThemeProps, ThemeRadius } from '../domain/index.js';
import { LruCache } from '../support/lru-cache.js';

const RADIUS: Record<ThemeRadius, string> = { none: '0', sm: '0.25rem', md: '0.5rem', lg: '1rem' };

/** Convierte un tema en variables CSS. Los valores ya vienen validados por el dominio. */
export function themeToCss(theme: Theme): string {
  const vars: [string, string][] = [
    ['--color-primary', theme.primary.value],
    ['--color-secondary', theme.secondary.value],
  ];
  if (theme.accent) vars.push(['--color-accent', theme.accent.value]);
  if (theme.background) vars.push(['--color-background', theme.background.value]);
  if (theme.text) vars.push(['--color-text', theme.text.value]);
  if (theme.font) vars.push(['--font-main', `'${theme.font}', system-ui, sans-serif`]);
  if (theme.radius) vars.push(['--radius', RADIUS[theme.radius]]);
  for (const [key, value] of Object.entries(theme.custom)) vars.push([`--${key}`, value]);
  if (theme.mode) vars.push(['color-scheme', theme.mode === 'auto' ? 'light dark' : theme.mode]);

  return `:root {\n${vars.map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}\n`;
}

export interface RenderedTheme {
  readonly css: string;
  /** ETag fuerte para `If-None-Match`. */
  readonly etag: string;
  readonly json: ThemeProps;
}

/** Genera el CSS una sola vez por versión del tema y lo guarda en un LRU. */
export class ThemeRenderer {
  private readonly cache = new LruCache<string, RenderedTheme>({ max: 5_000 });

  render(cacheKey: string, theme: Theme): RenderedTheme {
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const css = themeToCss(theme);
    const rendered: RenderedTheme = Object.freeze({
      css,
      etag: `"${createHash('sha1').update(css).digest('base64url')}"`,
      json: theme.toJSON(),
    });
    this.cache.set(cacheKey, rendered);
    return rendered;
  }

  clear(): void {
    this.cache.clear();
  }
}
