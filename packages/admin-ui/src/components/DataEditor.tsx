import { Button, Input } from './ui';

/** Una fila de `tenant.data`. Los valores que no son texto se editan como JSON. */
export interface DataRow {
  key: string;
  value: string;
  json?: boolean;
}

export function rowsFromData(
  data: Record<string, unknown>,
  skip: ReadonlySet<string> = new Set(),
): DataRow[] {
  return Object.entries(data)
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) =>
      typeof value === 'string'
        ? { key, value }
        : { key, value: JSON.stringify(value), json: true },
    );
}

/** Convierte las filas en `data`. Lanza si una llave se repite o un valor JSON no es válido. */
export function dataFromRows(rows: readonly DataRow[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (key in data) throw new Error(`La llave "${key}" está repetida`);
    if (!row.json) data[key] = row.value;
    else {
      try {
        data[key] = JSON.parse(row.value);
      } catch {
        throw new Error(`El valor de "${key}" no es JSON válido`);
      }
    }
  }
  return data;
}

export function DataEditor({
  rows,
  onChange,
  disabled,
}: {
  rows: DataRow[];
  onChange: (rows: DataRow[]) => void;
  disabled?: boolean;
}) {
  const update = (index: number, patch: Partial<DataRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div className="space-y-2" data-testid="data-editor">
      {rows.map((row, i) => (
        <div key={i} className="flex gap-2">
          <div className="w-1/3">
            <Input
              aria-label={`Llave ${i + 1}`}
              placeholder="llave"
              value={row.key}
              disabled={disabled}
              onChange={(e) => update(i, { key: e.target.value })}
            />
          </div>
          <div className="flex-1">
            <Input
              aria-label={`Valor ${i + 1}`}
              placeholder={row.json ? 'JSON' : 'valor'}
              value={row.value}
              disabled={disabled}
              className={row.json ? 'font-mono text-xs' : undefined}
              onChange={(e) => update(i, { value: e.target.value })}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            aria-label={`Quitar ${row.key || `fila ${i + 1}`}`}
            disabled={disabled}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            ✕
          </Button>
        </div>
      ))}
      <Button
        type="button"
        disabled={disabled}
        onClick={() => onChange([...rows, { key: '', value: '' }])}
      >
        Agregar dato
      </Button>
    </div>
  );
}
