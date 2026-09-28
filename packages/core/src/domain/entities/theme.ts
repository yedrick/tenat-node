import { InvalidThemeError } from '../errors/errors.js';
import { HexColor } from '../value-objects/hex-color.js';

export const THEME_RADII = ['none', 'sm', 'md', 'lg'] as const;
export const THEME_MODES = ['light', 'dark', 'auto'] as const;

export type ThemeRadius = (typeof THEME_RADII)[number];
export type ThemeMode = (typeof THEME_MODES)[number];

/** Forma serializable de un tema (lo que se guarda en la columna `theme`). */
export interface ThemeProps {
  primary: string;
  secondary: string;
  accent?: string;
  background?: string;
  text?: string;
  logo?: string;
  favicon?: string;
  font?: string;
  radius?: ThemeRadius;
  mode?: ThemeMode;
  custom?: Record<string, string>;
}

/** Cambio parcial de un tema. `null` quita un campo opcional. */
export type ThemePatch = {
  [K in keyof ThemeProps]?: K extends 'primary' | 'secondary'
    ? ThemeProps[K]
    : ThemeProps[K] | null;
};

const FONT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const ASSET_PATTERN = /^[^\s"'()<>\\]{1,500}$/;
const CUSTOM_KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const CUSTOM_VALUE_PATTERN = /^[^;{}<>\\"'\n\r]{1,200}$/;
const MAX_CUSTOM_VARIABLES = 50;

/** Tema visual de un tenant. Inmutable: `merge` devuelve un tema nuevo. */
export class Theme {
  private constructor(
    readonly primary: HexColor,
    readonly secondary: HexColor,
    readonly accent: HexColor | undefined,
    readonly background: HexColor | undefined,
    readonly text: HexColor | undefined,
    readonly logo: string | undefined,
    readonly favicon: string | undefined,
    readonly font: string | undefined,
    readonly radius: ThemeRadius | undefined,
    readonly mode: ThemeMode | undefined,
    readonly custom: Readonly<Record<string, string>>,
  ) {}

  static create(props: ThemeProps): Theme {
    return new Theme(
      HexColor.create(props.primary),
      HexColor.create(props.secondary),
      optionalColor(props.accent),
      optionalColor(props.background),
      optionalColor(props.text),
      optionalAsset('logo', props.logo),
      optionalAsset('favicon', props.favicon),
      optionalFont(props.font),
      optionalEnum('radius', props.radius, THEME_RADII),
      optionalEnum('mode', props.mode, THEME_MODES),
      validateCustom(props.custom),
    );
  }

  /** Aplica un cambio parcial y valida el resultado completo. */
  merge(patch: ThemePatch): Theme {
    const next: Record<string, unknown> = { ...this.toJSON() };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return Theme.create(next as unknown as ThemeProps);
  }

  equals(other: Theme): boolean {
    return JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON());
  }

  toJSON(): ThemeProps {
    const props: ThemeProps = { primary: this.primary.value, secondary: this.secondary.value };
    if (this.accent) props.accent = this.accent.value;
    if (this.background) props.background = this.background.value;
    if (this.text) props.text = this.text.value;
    if (this.logo !== undefined) props.logo = this.logo;
    if (this.favicon !== undefined) props.favicon = this.favicon;
    if (this.font !== undefined) props.font = this.font;
    if (this.radius !== undefined) props.radius = this.radius;
    if (this.mode !== undefined) props.mode = this.mode;
    if (Object.keys(this.custom).length > 0) props.custom = { ...this.custom };
    return props;
  }
}

function optionalColor(value: string | undefined): HexColor | undefined {
  return value === undefined ? undefined : HexColor.create(value);
}

function optionalAsset(field: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ASSET_PATTERN.test(value)) {
    throw new InvalidThemeError(
      field,
      'must be a path or URL without spaces, quotes or parentheses',
    );
  }
  return value;
}

function optionalFont(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !FONT_PATTERN.test(value)) {
    throw new InvalidThemeError(
      'font',
      'must be a font family name (letters, digits, spaces, "_" or "-")',
    );
  }
  return value;
}

function optionalEnum<T extends string>(
  field: string,
  value: T | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value))
    throw new InvalidThemeError(field, `must be one of ${allowed.join(', ')}`);
  return value;
}

function validateCustom(
  custom: Record<string, string> | undefined,
): Readonly<Record<string, string>> {
  if (custom === undefined) return Object.freeze({});
  if (typeof custom !== 'object' || custom === null || Array.isArray(custom)) {
    throw new InvalidThemeError('custom', 'must be an object of CSS variables');
  }
  const entries = Object.entries(custom);
  if (entries.length > MAX_CUSTOM_VARIABLES) {
    throw new InvalidThemeError('custom', `at most ${MAX_CUSTOM_VARIABLES} variables are allowed`);
  }
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!CUSTOM_KEY_PATTERN.test(key)) {
      throw new InvalidThemeError(`custom.${key}`, 'variable names use a-z, 0-9 and "-"');
    }
    if (
      typeof value !== 'string' ||
      !CUSTOM_VALUE_PATTERN.test(value) ||
      value.includes('/*') ||
      /url\s*\(|expression\s*\(/i.test(value)
    ) {
      throw new InvalidThemeError(`custom.${key}`, 'value is not a safe CSS value');
    }
    result[key] = value;
  }
  return Object.freeze(result);
}
