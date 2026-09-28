/**
 * Parser CSV (RFC 4180): comillas dobles, comas y saltos de línea dentro de comillas,
 * `""` como comilla escapada, BOM y finales de línea CRLF.
 */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field.length === 0) quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (quoted) throw new Error('CSV: unterminated quoted field');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ''));
}

export interface CsvRecord {
  /** Número de línea en el archivo (la cabecera es la 1). */
  line: number;
  values: Record<string, string>;
}

/** Convierte las filas en objetos usando la primera fila como cabecera (en minúsculas). */
export function csvRecords(text: string): { headers: string[]; records: CsvRecord[] } {
  const [header, ...rows] = parseCsv(text);
  if (!header) return { headers: [], records: [] };
  const headers = header.map((h) => h.trim().toLowerCase());
  return {
    headers,
    records: rows.map((row, index) => ({
      line: index + 2,
      values: Object.fromEntries(headers.map((h, i) => [h, (row[i] ?? '').trim()])),
    })),
  };
}
