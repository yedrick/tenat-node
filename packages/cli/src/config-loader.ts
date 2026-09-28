import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  createTenancy,
  InvalidConfigError,
  type Logger,
  type Tenancy,
  type TenancyConfig,
} from '@tenancy-node/core';
import type { DatabaseExtension } from '@tenancy-node/db';
import { createJiti } from 'jiti';

export const CONFIG_FILES = [
  'tenancy.config.ts',
  'tenancy.config.mts',
  'tenancy.config.cts',
  'tenancy.config.js',
  'tenancy.config.mjs',
  'tenancy.config.cjs',
] as const;

export type CliTenancy = Tenancy & Partial<DatabaseExtension>;

export interface LoadOptions {
  cwd: string;
  /** Ruta explícita (`--config`). */
  configPath?: string | undefined;
  /** Logger que se usa si la configuración no trae uno. */
  logger: Logger;
  /** Alias de módulos para jiti (los tests apuntan al código fuente). */
  alias?: Record<string, string>;
}

export interface LoadedConfig {
  tenancy: CliTenancy;
  file: string;
}

export function findConfigFile(cwd: string, explicit?: string): string | undefined {
  if (explicit) {
    const file = path.resolve(cwd, explicit);
    return existsSync(file) ? file : undefined;
  }
  return CONFIG_FILES.map((name) => path.join(cwd, name)).find((file) => existsSync(file));
}

function isTenancy(value: unknown): value is Tenancy {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Tenancy).runForEach === 'function' &&
    typeof (value as Tenancy).tenants === 'object'
  );
}

/**
 * Carga `tenancy.config.*` (TypeScript o JavaScript, ESM o CommonJS, sin compilar).
 * Acepta: `export default defineConfig({...})`, `export default tenancy` o `export const tenancy`.
 */
export async function loadTenancy(options: LoadOptions): Promise<LoadedConfig> {
  const file = findConfigFile(options.cwd, options.configPath);
  if (!file) {
    throw new InvalidConfigError(
      options.configPath
        ? `Config file not found: ${options.configPath}`
        : `No tenancy.config.(ts|js|mjs|cjs) in ${options.cwd}. Run "tenancy init" first.`,
    );
  }
  const jiti = createJiti(path.join(options.cwd, 'noop.js'), {
    interopDefault: true,
    ...(options.alias ? { alias: options.alias } : {}),
  });
  const mod = (await jiti.import(file)) as Record<string, unknown> & { default?: unknown };
  const candidate = mod.default ?? mod.tenancy ?? mod.config;

  if (isTenancy(candidate)) return { tenancy: candidate as CliTenancy, file };
  if (isTenancy(mod.tenancy)) return { tenancy: mod.tenancy as CliTenancy, file };
  if (typeof candidate === 'object' && candidate !== null) {
    const config = candidate as TenancyConfig;
    const tenancy = createTenancy({ ...config, logger: config.logger ?? options.logger });
    return { tenancy: tenancy as CliTenancy, file };
  }
  throw new InvalidConfigError(
    `${path.basename(file)} must export a tenancy config (defineConfig) or a tenancy instance`,
  );
}

export function hasDatabase(tenancy: CliTenancy): tenancy is Tenancy & DatabaseExtension {
  return typeof tenancy.database === 'object' && typeof tenancy.database?.install === 'function';
}
