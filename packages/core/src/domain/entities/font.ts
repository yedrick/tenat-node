import { InvalidConfigError, InvalidThemeError } from '../errors/errors.js';

export const FONT_SOURCES = ['google', 'system', 'url'] as const;
export type FontSource = (typeof FONT_SOURCES)[number];

/** Fuente que los tenants pueden elegir en su tema. */
export interface FontDefinition {
  /** Nombre de la familia (`Inter`, `Open Sans`). Es lo que se guarda en `theme.font`. */
  family: string;
  /** De dónde se carga. `google` (por defecto): Google Fonts; `system`: ya instalada; `url`: tu propio CSS. */
  source?: FontSource;
  /** Grosores a cargar (Google). Por defecto `[400, 600, 700]`. */
  weights?: readonly number[];
  /** CSS de la fuente (`source: 'url'`), por ejemplo un `@font-face` servido por tu app. */
  url?: string;
  /** Fuentes de respaldo. Por defecto `system-ui, sans-serif`. */
  fallback?: string;
  /** Nombre a mostrar en el panel. Por defecto `family`. */
  label?: string;
}

/** Fuente ya validada, con la URL de su CSS (si hay que cargarlo). */
export interface ResolvedFont {
  family: string;
  label: string;
  source: FontSource;
  weights: number[];
  /** CSS que carga la fuente; `null` en las de sistema. */
  cssUrl: string | null;
  /** Valor completo de `font-family` (`'Inter', system-ui, sans-serif`). */
  stack: string;
}

const FAMILY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const FALLBACK_PATTERN = /^[A-Za-z0-9 ,_'-]{1,200}$/;
const URL_PATTERN = /^(https:\/\/|\/)[^\s"'()<>\\]{1,500}$/;
const DEFAULT_WEIGHTS = [400, 600, 700];
const DEFAULT_FALLBACK = 'system-ui, sans-serif';

/**
 * Lista de fuentes permitidas (`theme.fonts` de la configuración). Vacía = cualquier nombre
 * válido, sin carga automática (como antes de 0.11).
 */
export class FontCatalog {
  private readonly fonts: ReadonlyMap<string, ResolvedFont>;

  constructor(definitions: readonly FontDefinition[] = []) {
    const fonts = new Map<string, ResolvedFont>();
    for (const def of definitions) {
      const font = resolveFont(def);
      if (fonts.has(font.family))
        throw new InvalidConfigError(`theme.fonts: duplicated family "${font.family}"`);
      fonts.set(font.family, font);
    }
    this.fonts = fonts;
  }

  get restricted(): boolean {
    return this.fonts.size > 0;
  }

  list(): ResolvedFont[] {
    return [...this.fonts.values()].map((f) => ({ ...f, weights: [...f.weights] }));
  }

  get(family: string): ResolvedFont | undefined {
    return this.fonts.get(family);
  }

  /** Lanza `InvalidThemeError` si hay lista y la fuente no está en ella. */
  validate(family: string | undefined): void {
    if (family === undefined || !this.restricted || this.fonts.has(family)) return;
    throw new InvalidThemeError(
      'font',
      `"${family}" is not an allowed font (${[...this.fonts.keys()].join(', ')})`,
    );
  }
}

function resolveFont(def: FontDefinition): ResolvedFont {
  const fail = (reason: string) => new InvalidConfigError(`theme.fonts: ${reason}`);
  if (!def || typeof def.family !== 'string' || !FAMILY_PATTERN.test(def.family))
    throw fail(`invalid family "${String(def?.family)}"`);
  const source = def.source ?? 'google';
  if (!FONT_SOURCES.includes(source)) throw fail(`${def.family}: invalid source "${source}"`);
  const weights = [...new Set(def.weights ?? DEFAULT_WEIGHTS)].sort((a, b) => a - b);
  for (const w of weights)
    if (!Number.isInteger(w) || w < 100 || w > 900)
      throw fail(`${def.family}: invalid weight ${w}`);
  const fallback = def.fallback ?? DEFAULT_FALLBACK;
  if (!FALLBACK_PATTERN.test(fallback)) throw fail(`${def.family}: invalid fallback`);
  let cssUrl: string | null = null;
  if (source === 'google') {
    cssUrl = `https://fonts.googleapis.com/css2?family=${def.family.replace(/ /g, '+')}:wght@${weights.join(';')}&display=swap`;
  } else if (source === 'url') {
    if (typeof def.url !== 'string' || !URL_PATTERN.test(def.url))
      throw fail(`${def.family}: url must be https:// or an absolute path`);
    cssUrl = def.url;
  }
  return {
    family: def.family,
    label: def.label ?? def.family,
    source,
    weights,
    cssUrl,
    stack: `'${def.family}', ${fallback}`,
  };
}
