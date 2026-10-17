import { InvalidPlatformError } from '../errors/errors.js';
import { HexColor } from '../value-objects/hex-color.js';

/** Marca y contacto de la plataforma (el dominio central): web comercial, correos, panel. */
export interface PlatformSettings {
  name: string | null;
  /** Ruta en el almacenamiento central (`platform/logo-….png`) o URL absoluta. */
  logo: string | null;
  favicon: string | null;
  /** Color principal (`#RRGGBB`). */
  primary: string | null;
  contact: {
    /** Solo dígitos, con código de país (`59170000000`). */
    whatsapp: string | null;
    email: string | null;
  };
  /** Correos que reciben los avisos de ventas (solicitudes). Privado: no sale en la ruta pública. */
  salesNotifyTo: string[];
}

export type PlatformPatch = {
  name?: string | null;
  logo?: string | null;
  favicon?: string | null;
  primary?: string | null;
  contact?: { whatsapp?: string | null; email?: string | null };
  salesNotifyTo?: readonly string[];
};

export const EMPTY_PLATFORM: PlatformSettings = {
  name: null,
  logo: null,
  favicon: null,
  primary: null,
  contact: { whatsapp: null, email: null },
  salesNotifyTo: [],
};

const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[^\s@<>"']{2,}$/;
const ASSET = /^[^\s"'()<>\\]{1,500}$/;

/** Aplica un cambio parcial y valida el resultado. `null` borra un campo. */
export function mergePlatform(current: PlatformSettings, patch: PlatformPatch): PlatformSettings {
  const fail = (field: string, reason: string) => new InvalidPlatformError(field, reason);
  const next: PlatformSettings = structuredClone(current);
  if (patch.name !== undefined) {
    const name = patch.name === null ? null : String(patch.name).trim();
    if (name !== null && (name.length === 0 || name.length > 100))
      throw fail('name', 'must have 1 to 100 characters');
    next.name = name;
  }
  for (const field of ['logo', 'favicon'] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value !== null && (typeof value !== 'string' || !ASSET.test(value)))
      throw fail(field, 'must be a storage path or URL without spaces or quotes');
    next[field] = value;
  }
  if (patch.primary !== undefined) {
    if (patch.primary === null) next.primary = null;
    else {
      try {
        next.primary = HexColor.create(patch.primary).value;
      } catch {
        throw fail('primary', 'must be a #RRGGBB color');
      }
    }
  }
  if (patch.contact?.whatsapp !== undefined) {
    const raw = patch.contact.whatsapp;
    const digits = raw === null ? null : String(raw).replace(/[\s()+.-]/g, '');
    if (digits !== null && !/^\d{8,15}$/.test(digits))
      throw fail('contact.whatsapp', 'must be 8 to 15 digits with the country code (59170000000)');
    next.contact.whatsapp = digits;
  }
  if (patch.contact?.email !== undefined) {
    const email = patch.contact.email === null ? null : String(patch.contact.email).trim();
    if (email !== null && !EMAIL.test(email))
      throw fail('contact.email', 'must be an email address');
    next.contact.email = email;
  }
  if (patch.salesNotifyTo !== undefined) {
    if (!Array.isArray(patch.salesNotifyTo) || patch.salesNotifyTo.length > 20)
      throw fail('salesNotifyTo', 'must be a list of up to 20 emails');
    const list = [...new Set(patch.salesNotifyTo.map((e) => String(e).trim()))];
    for (const e of list)
      if (!EMAIL.test(e)) throw fail('salesNotifyTo', `"${e}" is not an email address`);
    next.salesNotifyTo = list;
  }
  return next;
}
