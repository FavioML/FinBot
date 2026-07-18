// Parser de archivos de carga masiva (Excel/CSV) → filas normalizadas de transacción.
//
// Extraído del handler de documentos de handlers/webhook.js sin cambio de
// comportamiento, para poder testearlo aislado (tests en tests/import-parser.test.js)
// y reusarlo. La auto-categorización con IA y la inserción viven en el llamador
// (webhook.js), no acá: este módulo solo parsea y normaliza.
//
// Formato de fila devuelto:
//   { fecha:'YYYY-MM-DD', monto:number, comercio:string, tipo:'gasto'|'ingreso',
//     categoria:string|null, subcategoria:string|null, metodo_pago:string|null, banco:string|null }

/**
 * Parsea un CSV de estado de cuenta bancario o plantilla de gastos.
 * Auto-detecta separador (, ; \t) y columnas por nombre de header.
 * @param {string} csvText
 * @returns {Array<object>} filas normalizadas
 * @throws si el CSV está vacío o no tiene columnas mínimas (fecha + monto/descripción)
 */
function parseCSV(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('El archivo CSV está vacío.');

  // Detectar separador (coma, punto y coma, tab)
  const firstLine = lines[0];
  const sep = firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ',';
  const headers = firstLine.split(sep).map((h) => h.replace(/"/g, '').trim().toLowerCase());

  // Auto-detectar columnas por nombre de header
  const iDate = headers.findIndex((h) => h.includes('fecha') || h === 'date' || h.includes('fec'));
  const iAmount = headers.findIndex((h) => h.includes('monto') || h.includes('importe') || h.includes('cargo') || h.includes('amount') || h === 'debito');
  const iDesc = headers.findIndex((h) => h.includes('descripci') || h.includes('concepto') || h.includes('detalle') || h.includes('comercio') || h.includes('description') || h.includes('movimiento'));
  const iCredit = headers.findIndex((h) => h.includes('abono') || h.includes('credito') || h.includes('credit') || h.includes('deposito'));

  if (iDate < 0 || (iAmount < 0 && iDesc < 0)) throw new Error('No pude detectar las columnas del CSV. Necesito al menos Fecha y Monto/Descripción.');

  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = lines[li].split(sep).map((c) => c.replace(/"/g, '').trim());
    if (!cols[iDate]) continue;

    // Normalizar fecha (DD/MM/YY o DD-MM-YYYY → YYYY-MM-DD)
    let fechaStr = cols[iDate];
    const parts = fechaStr.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})$/);
    if (parts) {
      const anio = parts[3].length === 2 ? '20' + parts[3] : parts[3];
      fechaStr = anio + '-' + parts[2].padStart(2, '0') + '-' + parts[1].padStart(2, '0');
    }

    // Monto: cargo (gasto) vs abono (ingreso)
    let monto = 0;
    let tipo = 'gasto';
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
 * Parsea un Excel (.xlsx) de plantilla de gastos. Auto-detecta la fila de header
 * y el formato de columnas: legacy6 (Fecha,Monto,Comercio,Categoría,Método,Banco),
 * tipo7 (+Tipo) o full8 (+Subcategoría).
 * @param {Buffer} fileBuffer
 * @returns {Promise<Array<object>>} filas normalizadas
 * @throws si el archivo no tiene hojas
 */
async function parseExcel(fileBuffer) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer);
  const sheet = workbook.getWorksheet(1);
  if (!sheet) throw new Error('El archivo no tiene hojas de cálculo');

  const rows = [];
  let headerRow = null;
  let colFormat = 'legacy6'; // legacy6 | tipo7 | full8
  sheet.eachRow((row, rowNumber) => {
    const vals = row.values.slice(1); // exceljs es 1-indexed
    const firstVal = String(vals[0] || '').toLowerCase();
    if (firstVal.includes('fecha') || firstVal.includes('date')) {
      headerRow = rowNumber;
      // Detectar formato por headers
      const headers = vals.map((v) => String(v || '').toLowerCase());
      const hasSubcatCol = headers.some((h) => h.includes('subcategor'));
      const hasTipoCol = headers.some((h) => h === 'tipo' || h === 'type');
      if (hasSubcatCol) colFormat = 'full8';
      else if (hasTipoCol) colFormat = 'tipo7';
      else colFormat = 'legacy6';
      return;
    }
    if (headerRow && rowNumber > headerRow) {
      const fecha = vals[0];
      const monto = parseFloat(vals[1]);
      const comercio = String(vals[2] || '').trim();
      let tipo;
      let categoria;
      let subcategoria;
      let metodo;
      let banco;
      if (colFormat === 'full8') {
        // 8 cols: Fecha, Monto, Comercio, Tipo, Categoría, Subcategoría, Método, Banco
        const tipoRaw = String(vals[3] || '').trim().toLowerCase();
        tipo = tipoRaw.includes('ingreso') ? 'ingreso' : 'gasto';
        categoria = String(vals[4] || '').trim();
        subcategoria = String(vals[5] || '').trim() || null;
        metodo = String(vals[6] || '').trim();
        banco = String(vals[7] || '').trim();
      } else if (colFormat === 'tipo7') {
        // 7 cols: Fecha, Monto, Comercio, Tipo, Categoría, Método, Banco
        const tipoRaw = String(vals[3] || '').trim().toLowerCase();
        tipo = tipoRaw.includes('ingreso') ? 'ingreso' : 'gasto';
        categoria = String(vals[4] || '').trim();
        subcategoria = null;
        metodo = String(vals[5] || '').trim();
        banco = String(vals[6] || '').trim();
      } else {
        // 6 cols legacy: Fecha, Monto, Comercio, Categoría, Método, Banco
        tipo = 'gasto';
        categoria = String(vals[3] || '').trim();
        subcategoria = null;
        metodo = String(vals[4] || '').trim();
        banco = String(vals[5] || '').trim();
      }

      if (!fecha || isNaN(monto) || monto <= 0 || !comercio) return; // Skip filas inválidas

      // Normalizar fecha
      let fechaStr;
      if (fecha instanceof Date) {
        fechaStr = fecha.toISOString().split('T')[0];
      } else {
        fechaStr = String(fecha).trim();
        const parts = fechaStr.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
        if (parts) fechaStr = parts[3] + '-' + parts[2].padStart(2, '0') + '-' + parts[1].padStart(2, '0');
      }

      rows.push({ fecha: fechaStr, monto, comercio, tipo, categoria, subcategoria, metodo_pago: metodo || null, banco: banco || null });
    }
  });
  return rows;
}

module.exports = { parseCSV, parseExcel };
