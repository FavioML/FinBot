// Export CSV cliente-side (sin endpoint). Genera el CSV desde los datos ya cargados en la página y
// dispara la descarga vía Blob. UTF-8 con BOM para que Excel abra bien las tildes.

/** Escapa un valor de celda CSV (comas, comillas, saltos de línea). */
function escapeCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Arma un CSV desde headers + filas (cada fila es un array de celdas, en el orden de los headers). */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCell).join(','));
  return lines.join('\r\n');
}

/** Dispara la descarga de un CSV con BOM UTF-8. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
