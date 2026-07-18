// Parser server-only de carga masiva (Excel/CSV) → filas normalizadas.
//
// Espejo TS de services/import-parser.js (backend CJS). Misma lógica de
// auto-detección de columnas, normalización de fecha y cargo/abono. Vive acá
// porque el backend CommonJS no se puede importar desde el runtime de Next.
// Solo lo importa la ruta server-side /api/transactions/import — nunca el cliente
// (exceljs no debe entrar al bundle del browser).

import ExcelJS from 'exceljs';

export interface ImportRow {
  fecha: string;
  monto: number;
  comercio: string;
  tipo: 'gasto' | 'ingreso';
  categoria: string | null;
  subcategoria: string | null;
  metodo_pago: string | null;
  banco: string | null;
}

/**
 * Parsea un CSV de estado de cuenta o plantilla de gastos.
 * @throws si el CSV está vacío o no tiene columnas mínimas.
 */
export function parseCSV(csvText: string): ImportRow[] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('El archivo CSV está vacío.');

  const firstLine = lines[0];
  const sep = firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ',';
  const headers = firstLine.split(sep).map((h) => h.replace(/"/g, '').trim().toLowerCase());

  const iDate = headers.findIndex((h) => h.includes('fecha') || h === 'date' || h.includes('fec'));
  const iAmount = headers.findIndex((h) => h.includes('monto') || h.includes('importe') || h.includes('cargo') || h.includes('amount') || h === 'debito');
  const iDesc = headers.findIndex((h) => h.includes('descripci') || h.includes('concepto') || h.includes('detalle') || h.includes('comercio') || h.includes('description') || h.includes('movimiento'));
  const iCredit = headers.findIndex((h) => h.includes('abono') || h.includes('credito') || h.includes('credit') || h.includes('deposito'));

  if (iDate < 0 || (iAmount < 0 && iDesc < 0)) throw new Error('No pude detectar las columnas del CSV. Necesito al menos Fecha y Monto/Descripción.');

  const rows: ImportRow[] = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = lines[li].split(sep).map((c) => c.replace(/"/g, '').trim());
    if (!cols[iDate]) continue;

    let fechaStr = cols[iDate];
    const parts = fechaStr.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (parts) {
      const anio = parts[3].length === 2 ? '20' + parts[3] : parts[3];
      fechaStr = anio + '-' + parts[2].padStart(2, '0') + '-' + parts[1].padStart(2, '0');
    }

    let monto = 0;
    let tipo: 'gasto' | 'ingreso' = 'gasto';
    if (iAmount >= 0) {
      monto = parseFloat((cols[iAmount] || '0').replace(/[,\s]/g, ''));
    }
    if (iCredit >= 0 && cols[iCredit] && parseFloat(cols[iCredit].replace(/[,\s]/g, '')) > 0) {
      monto = parseFloat(cols[iCredit].replace(/[,\s]/g, ''));
      tipo = 'ingreso';
    }
    if (isNaN(monto) || monto <= 0) continue;

    const comercio = iDesc >= 0 ? (cols[iDesc] || 'Sin descripción').substring(0, 100) : 'Sin descripción';
    rows.push({ fecha: fechaStr, monto, comercio, tipo, categoria: null, subcategoria: null, metodo_pago: null, banco: null });
  }
  return rows;
}

/**
 * Parsea un Excel (.xlsx) de plantilla. Auto-detecta header y formato de columnas
 * (legacy6 | tipo7 | full8).
 * @throws si el archivo no tiene hojas.
 */
export async function parseExcel(fileBuffer: Buffer): Promise<ImportRow[]> {
  const workbook = new ExcelJS.Workbook();
  // exceljs empaqueta su propio tipo Buffer (más viejo que el Buffer genérico de
  // @types/node); casteamos al tipo exacto del parámetro para conciliar sin `any`.
  await workbook.xlsx.load(fileBuffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet(1);
  if (!sheet) throw new Error('El archivo no tiene hojas de cálculo');

  const rows: ImportRow[] = [];
  let headerRow: number | null = null;
  let colFormat: 'legacy6' | 'tipo7' | 'full8' = 'legacy6';
  sheet.eachRow((row, rowNumber) => {
    const vals = (row.values as unknown[]).slice(1);
    const firstVal = String(vals[0] || '').toLowerCase();
    if (firstVal.includes('fecha') || firstVal.includes('date')) {
      headerRow = rowNumber;
      const hdrs = vals.map((v) => String(v || '').toLowerCase());
      const hasSubcatCol = hdrs.some((h) => h.includes('subcategor'));
      const hasTipoCol = hdrs.some((h) => h === 'tipo' || h === 'type');
      if (hasSubcatCol) colFormat = 'full8';
      else if (hasTipoCol) colFormat = 'tipo7';
      else colFormat = 'legacy6';
      return;
    }
    if (headerRow && rowNumber > headerRow) {
      const fecha = vals[0];
      const monto = parseFloat(String(vals[1]));
      const comercio = String(vals[2] || '').trim();
      let tipo: 'gasto' | 'ingreso';
      let categoria: string;
      let subcategoria: string | null;
      let metodo: string;
      let banco: string;
      if (colFormat === 'full8') {
        const tipoRaw = String(vals[3] || '').trim().toLowerCase();
        tipo = tipoRaw.includes('ingreso') ? 'ingreso' : 'gasto';
        categoria = String(vals[4] || '').trim();
        subcategoria = String(vals[5] || '').trim() || null;
        metodo = String(vals[6] || '').trim();
        banco = String(vals[7] || '').trim();
      } else if (colFormat === 'tipo7') {
        const tipoRaw = String(vals[3] || '').trim().toLowerCase();
        tipo = tipoRaw.includes('ingreso') ? 'ingreso' : 'gasto';
        categoria = String(vals[4] || '').trim();
        subcategoria = null;
        metodo = String(vals[5] || '').trim();
        banco = String(vals[6] || '').trim();
      } else {
        tipo = 'gasto';
        categoria = String(vals[3] || '').trim();
        subcategoria = null;
        metodo = String(vals[4] || '').trim();
        banco = String(vals[5] || '').trim();
      }

      if (!fecha || isNaN(monto) || monto <= 0 || !comercio) return;

      let fechaStr: string;
      if (fecha instanceof Date) {
        fechaStr = fecha.toISOString().split('T')[0];
      } else {
        fechaStr = String(fecha).trim();
        const parts = fechaStr.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
        if (parts) fechaStr = parts[3] + '-' + parts[2].padStart(2, '0') + '-' + parts[1].padStart(2, '0');
      }

      rows.push({ fecha: fechaStr, monto, comercio, tipo, categoria: categoria || null, subcategoria, metodo_pago: metodo || null, banco: banco || null });
    }
  });
  return rows;
}
