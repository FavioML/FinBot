/**
 * Genera la plantilla Excel para carga de gastos históricos.
 * Ejecutar una vez: node scripts/create_template.js
 */
const ExcelJS = require('exceljs');
const path = require('path');

async function main() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NETO';
  wb.created = new Date();

  const ws = wb.addWorksheet('Gastos', {
    properties: { defaultColWidth: 18 }
  });

  // --- Instrucciones (fila 1, celdas combinadas) ---
  ws.mergeCells('A1:F1');
  const instrCell = ws.getCell('A1');
  instrCell.value = 'PLANTILLA NETO — Carga de Gastos Históricos. Completa cada fila con un gasto. Las columnas Categoría, Método de Pago y Banco son opcionales (NETO las asigna automáticamente con IA).';
  instrCell.font = { size: 11, italic: true, color: { argb: 'FF666666' } };
  instrCell.alignment = { wrapText: true, vertical: 'middle' };
  ws.getRow(1).height = 40;

  // --- Headers (fila 2) ---
  const headers = ['Fecha', 'Monto', 'Comercio / Descripción', 'Categoría', 'Método de Pago', 'Banco'];
  const headerRow = ws.getRow(2);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D9E75' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF0F6E56' } }
    };
  });
  headerRow.height = 28;

  // --- Columnas con ancho ---
  ws.columns = [
    { width: 14 },  // Fecha
    { width: 12 },  // Monto
    { width: 30 },  // Comercio
    { width: 18 },  // Categoría
    { width: 18 },  // Método de Pago
    { width: 16 },  // Banco
  ];

  // --- Ejemplos (filas 3-4) ---
  const ejemplos = [
    ['15/01/2026', 45.50, 'Supermercado Metro', 'Alimentación', 'Yape', 'BCP'],
    ['16/01/2026', 12.00, 'Taxi al centro', '', 'Efectivo', ''],
  ];
  ejemplos.forEach((ej, idx) => {
    const row = ws.getRow(3 + idx);
    ej.forEach((val, i) => {
      const cell = row.getCell(i + 1);
      cell.value = val;
      cell.font = { size: 10, color: { argb: 'FF999999' }, italic: true };
    });
  });

  // --- Validación: Categoría (columna D, filas 3-502) ---
  const categorias = [
    'Alimentación', 'Transporte', 'Vivienda', 'Salud',
    'Entretenimiento', 'Compras', 'Educación', 'Finanzas',
    'Trabajo_Negocio', 'Otros'
  ];
  for (let r = 3; r <= 502; r++) {
    ws.getCell(`D${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"' + categorias.join(',') + '"'],
      showErrorMessage: true,
      errorTitle: 'Categoría inválida',
      error: 'Selecciona una categoría de la lista o déjala vacía para que NETO la asigne.',
    };
  }

  // --- Validación: Método de Pago (columna E, filas 3-502) ---
  const metodos = ['Yape', 'Plin', 'Débito', 'Crédito', 'Efectivo', 'Transferencia', 'Otro'];
  for (let r = 3; r <= 502; r++) {
    ws.getCell(`E${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"' + metodos.join(',') + '"'],
    };
  }

  // --- Validación: Banco (columna F, filas 3-502) ---
  const bancos = ['BCP', 'Interbank', 'BBVA', 'Scotiabank', 'Yape', 'Plin', 'Otro'];
  for (let r = 3; r <= 502; r++) {
    ws.getCell(`F${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"' + bancos.join(',') + '"'],
    };
  }

  // --- Formato numérico para Monto (columna B) ---
  for (let r = 3; r <= 502; r++) {
    ws.getCell(`B${r}`).numFmt = '#,##0.00';
  }

  const outputPath = path.join(__dirname, '..', 'public', 'plantilla_gastos.xlsx');
  await wb.xlsx.writeFile(outputPath);
  console.log('Plantilla generada en:', outputPath);
}

main().catch(e => { console.error(e); process.exit(1); });
