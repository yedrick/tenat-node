import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { get } from '../api';
import { Button, Card, DataTable, EmptyState, ErrorBox, Input, Select } from '../components/ui';

interface Table {
  name: string;
  rows: number;
  columns: { name: string; type: string; nullable: boolean; masked: boolean }[];
}
interface Rows {
  table: string;
  page: number;
  perPage: number;
  total: number;
  rows: Record<string, unknown>[];
}

export function DataExplorer({ tenantId }: { tenantId: string }) {
  const tables = useQuery({
    queryKey: ['tables', tenantId],
    queryFn: () => get<Table[]>(`/tenants/${tenantId}/tables`),
  });
  const [table, setTable] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [filterColumn, setFilterColumn] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const [applied, setApplied] = useState<[string, string] | null>(null);
  const current = tables.data?.find((t) => t.name === table) ?? null;
  const params = new URLSearchParams({
    page: String(page),
    perPage: '25',
    ...(applied ? { [`filter.${applied[0]}`]: applied[1] } : {}),
  });
  const rows = useQuery({
    queryKey: ['rows', tenantId, table, params.toString()],
    queryFn: () => get<Rows>(`/tenants/${tenantId}/tables/${encodeURIComponent(table!)}?${params}`),
    enabled: table !== null,
    placeholderData: keepPreviousData,
  });

  return (
    <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
      <Card title="Tablas">
        <ErrorBox error={tables.error} />
        <ul className="space-y-1 text-sm">
          {tables.data?.map((t) => (
            <li key={t.name}>
              <button
                onClick={() => (
                  setTable(t.name),
                  setPage(1),
                  setApplied(null),
                  setFilterColumn('')
                )}
                className={`w-full rounded px-2 py-1 text-left font-mono ${t.name === table ? 'bg-brand/10 text-brand' : 'hover:bg-surface'}`}
              >
                {t.name} <span className="text-xs text-muted">({t.rows})</span>
              </button>
            </li>
          ))}
          {tables.data?.length === 0 && <li className="text-muted">Sin tablas</li>}
        </ul>
      </Card>
      <Card
        title={current ? <span className="font-mono">{current.name}</span> : 'Datos'}
        actions={
          <span className="text-xs text-muted">
            Solo lectura · cada consulta queda en la auditoría
          </span>
        }
      >
        {!current ? (
          <EmptyState>Elige una tabla</EmptyState>
        ) : (
          <>
            <form
              className="mb-3 flex flex-wrap gap-2"
              onSubmit={(e) => (
                e.preventDefault(),
                setPage(1),
                setApplied(filterColumn ? [filterColumn, filterValue] : null)
              )}
            >
              <Select
                aria-label="Columna"
                options={[
                  ['', 'Filtrar por…'],
                  ...current.columns
                    .filter((c) => !c.masked)
                    .map((c) => [c.name, c.name] as [string, string]),
                ]}
                value={filterColumn}
                onChange={(e) => setFilterColumn(e.target.value)}
                className="max-w-44"
              />
              <Input
                aria-label="Valor"
                value={filterValue}
                onChange={(e) => setFilterValue(e.target.value)}
                className="max-w-44"
              />
              <Button type="submit">Filtrar</Button>
            </form>
            <ErrorBox error={rows.error} />
            <DataTable
              data={rows.data?.rows ?? []}
              empty={rows.isLoading ? 'Cargando…' : 'Sin filas'}
              columns={current.columns.map((c) => ({
                id: c.name,
                header: () => (
                  <span title={c.type}>
                    {c.name}
                    {c.masked && ' 🔒'}
                  </span>
                ),
                cell: ({ row }: { row: { original: Record<string, unknown> } }) => {
                  const value = row.original[c.name];
                  return value === null ? (
                    <span className="text-muted">null</span>
                  ) : (
                    <span className="font-mono text-xs">
                      {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                    </span>
                  );
                },
              }))}
            />
            {rows.data && rows.data.total > rows.data.perPage && (
              <div className="mt-3 flex items-center justify-end gap-2 text-sm">
                <Button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Anterior
                </Button>
                <span>
                  {(page - 1) * rows.data.perPage + 1}–
                  {Math.min(page * rows.data.perPage, rows.data.total)} de {rows.data.total}
                </span>
                <Button
                  disabled={page * rows.data.perPage >= rows.data.total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Siguiente
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
