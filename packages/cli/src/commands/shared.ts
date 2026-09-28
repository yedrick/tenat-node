import type { RunForEachResult } from '@tenancy-node/core';
import type { TenantRunReport } from '@tenancy-node/db';
import { hasDatabase, type CliTenancy } from '../config-loader.js';
import { EXIT, UsageError } from '../command.js';
import { formatDuration, type Output } from '../output.js';

export function requireDatabase(tenancy: CliTenancy) {
  if (!hasDatabase(tenancy)) {
    throw new UsageError(
      'This command needs the database plugin (@tenancy-node/db) in tenancy.config',
    );
  }
  return tenancy;
}

/** Imprime una línea por tenant a medida que termina. */
export function progress(out: Output, verbose: boolean) {
  return (report: TenantRunReport) => {
    const time = out.paint('gray', formatDuration(report.durationMs));
    if (report.ok) out.success(`${report.tenantId}  ${time}`);
    else out.error(`${report.tenantId}  ${out.describeError(report.error, verbose)}  ${time}`);
  };
}

/** Resumen final de una operación sobre varios tenants. Devuelve el código de salida. */
export function summarize(
  out: Output,
  action: readonly [singular: string, plural: string],
  result: RunForEachResult,
): number {
  out.data({
    succeeded: result.succeeded,
    failed: result.failed.map((f) => ({
      tenantId: f.tenantId,
      error:
        f.error instanceof Error
          ? {
              name: f.error.name,
              message: f.error.message,
              code: (f.error as { code?: string }).code,
            }
          : String(f.error),
    })),
  });
  out.line();
  const one = result.succeeded.length === 1;
  const ok = `${result.succeeded.length} ${one ? `tenant ${action[0]}` : `tenants ${action[1]}`}`;
  if (result.failed.length === 0) {
    out.success(ok);
    return EXIT.ok;
  }
  out.error(
    `${ok}, ${result.failed.length} con error: ${result.failed.map((f) => f.tenantId).join(', ')}`,
  );
  out.info(
    out.paint(
      'gray',
      'Los errores quedan en el log con su tenantId (usa --verbose para verlos completos).',
    ),
  );
  return EXIT.failed;
}
