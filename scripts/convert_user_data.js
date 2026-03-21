/**
 * Script temporal: convierte datos del usuario a plantilla NETO con subcategorías.
 * Ejecutar: node scripts/convert_user_data.js
 */
const ExcelJS = require('exceljs');

const CAT_MAP = {
  'Auto': 'Transporte', 'Comida': 'Alimentación', 'Compras': 'Compras',
  'Entretenimiento': 'Entretenimiento', 'Hogar': 'Vivienda', 'Neto.pe': 'Trabajo_Negocio',
  'Otros': 'Otros', 'Préstamos': 'Finanzas', 'Préstamos ': 'Finanzas',
  'Salud': 'Salud', 'Streaming': 'Entretenimiento', 'Transporte': 'Transporte',
  'Viajes': 'Otros', 'Sueldo': 'Finanzas', 'Bono': 'Finanzas',
};

const SUB_MAP = {
  // Auto → Transporte
  'Estacionamiento': { comercio: 'Estacionamiento', sub: 'estacionamiento' },
  'Gasolina':        { comercio: 'Gasolina', sub: 'gasolina' },
  'Impuesto Vehicular': { comercio: 'Impuesto vehicular', sub: 'sin_categoria' },
  'Lavado':          { comercio: 'Lavado de auto', sub: 'sin_categoria' },
  'Lavado ':         { comercio: 'Lavado de auto', sub: 'sin_categoria' },
  'Mantenimiento':   { comercio: 'Mantenimiento auto', sub: 'sin_categoria' },
  'Peaje':           { comercio: 'Peaje', sub: 'peaje' },
  'Seguro':          { comercio: 'Seguro vehicular', sub: 'sin_categoria' },
  // Comida → Alimentación
  'Almuerzo':        { comercio: 'Almuerzo', sub: 'restaurante' },
  'Cena':            { comercio: 'Cena', sub: 'restaurante' },
  'Compartir':       { comercio: 'Comida compartida', sub: 'restaurante' },
  'Desayuno':        { comercio: 'Desayuno', sub: 'cafeteria' },
  'Ingredientes':    { comercio: 'Ingredientes', sub: 'mercado' },
  'Restaurant':      { comercio: 'Restaurant', sub: 'restaurante' },
  'Snacks':          { comercio: 'Snacks', sub: 'snacks' },
  // Compras
  'Accesorios':      { comercio: 'Accesorios', sub: 'electronico' },
  'Regalos':         { comercio: 'Regalos', sub: 'sin_categoria' },
  'Ropa':            { comercio: 'Ropa', sub: 'ropa' },
  // Entretenimiento
  'Baile':           { comercio: 'Clases de baile', sub: 'hobbies' },
  'Cine':            { comercio: 'Cine', sub: 'cine' },
  'Conciertos':      { comercio: 'Concierto', sub: 'eventos' },
  'Salidas/Tragos':  { comercio: 'Salida/Tragos', sub: 'bares_clubs' },
  // Hogar → Vivienda
  'Alquiler':        { comercio: 'Alquiler', sub: 'alquiler' },
  'Catalina':        { comercio: 'Catalina', sub: 'mantenimiento' },
  'Celular':         { comercio: 'Plan celular', sub: 'internet' },
  'Internet':        { comercio: 'Internet hogar', sub: 'internet' },
  'Lina':            { comercio: 'Lina', sub: 'mantenimiento' },
  'Servicios':       { comercio: 'Servicios hogar', sub: 'mantenimiento' },
  'Supermercado':    { comercio: 'Supermercado', sub: 'sin_categoria' },
  // Streaming → Entretenimiento
  'Apple Music':     { comercio: 'Apple Music', sub: 'streaming' },
  'Claude':          { comercio: 'Claude AI', sub: 'streaming' },
  'Cloud Apple':     { comercio: 'iCloud', sub: 'streaming' },
  'Cloud Apple ':    { comercio: 'iCloud', sub: 'streaming' },
  'Google Storage':  { comercio: 'Google Storage', sub: 'streaming' },
  'Netflix':         { comercio: 'Netflix', sub: 'streaming' },
  'PedidosYa':       { comercio: 'PedidosYa', sub: 'delivery' },
  'Youtube':         { comercio: 'YouTube Premium', sub: 'streaming' },
  // Salud
  'Barbería':        { comercio: 'Barbería', sub: 'sin_categoria' },
  'Barbería ':       { comercio: 'Barbería', sub: 'sin_categoria' },
  'Higiene':         { comercio: 'Higiene personal', sub: 'farmacia' },
  'Medicina':        { comercio: 'Medicina', sub: 'farmacia' },
  // Transporte
  'Taxi':            { comercio: 'Taxi', sub: 'taxi' },
  // Préstamos → Finanzas
  'Préstamo 06/25':  { comercio: 'Préstamo Jun 2025', sub: 'prestamo' },
};

async function main() {
  const wbSrc = new ExcelJS.Workbook();
  await wbSrc.xlsx.readFile('C:/Users/USUARIO/Downloads/2026-01-01 ~ 12-31.xlsx');
  const src = wbSrc.getWorksheet(1);

  const wbDst = new ExcelJS.Workbook();
  await wbDst.xlsx.readFile('C:/finbot/public/plantilla_gastos.xlsx');
  const dst = wbDst.getWorksheet(1);

  const rows = [];
  src.eachRow((row, i) => {
    if (i === 1) return;
    const vals = row.values;
    const fechaRaw = vals[1];
    const cuentaOrig = vals[2] || '';
    const catOrig = (vals[3] || '').trim();
    const subOrig = (vals[4] || '');
    const nota = vals[5] || '';
    const monto = parseFloat(vals[6]) || 0;
    const tipoOrig = vals[7] || '';

    if (monto <= 0) return;

    const tipo = tipoOrig === 'Gastos' ? 'Gasto' : 'Ingreso';

    let fecha;
    if (fechaRaw instanceof Date) {
      fecha = fechaRaw.toISOString().split('T')[0];
    } else {
      const d = new Date(fechaRaw);
      fecha = d.toISOString().split('T')[0];
    }
    const [y, m, d2] = fecha.split('-');
    const fechaFmt = d2 + '/' + m + '/' + y;

    const catNeto = CAT_MAP[catOrig] || 'Otros';

    // Subcategoría y comercio
    const mapping = SUB_MAP[subOrig] || SUB_MAP[catOrig] || null;
    let comercio = mapping ? mapping.comercio : (subOrig || catOrig);
    let subcategoria = mapping ? mapping.sub : 'sin_categoria';
    if (nota) comercio = nota;

    // PedidosYa con nota → Alimentación > delivery (la nota tiene el nombre del restaurante)
    if (subOrig === 'PedidosYa' && nota) {
      subcategoria = 'delivery';
    }

    // Método de pago
    let metodo = '';
    if (cuentaOrig.toLowerCase().includes('yape')) metodo = 'Yape';
    else if (cuentaOrig.toLowerCase().includes('efectivo')) metodo = 'Efectivo';
    else if (cuentaOrig.toLowerCase().includes('credito') || cuentaOrig.toLowerCase().includes('crédito')) metodo = 'Crédito';
    else if (cuentaOrig.toLowerCase().includes('ahorro')) metodo = 'Débito';

    rows.push({ fecha: fechaFmt, monto, comercio, tipo, categoria: catNeto, subcategoria, metodo, banco: '' });
  });

  rows.sort((a, b) => {
    const [da, ma, ya] = a.fecha.split('/');
    const [db, mb, yb] = b.fecha.split('/');
    return new Date(ya, ma - 1, da) - new Date(yb, mb - 1, db);
  });

  // Limpiar filas ejemplo
  for (let r = 3; r <= 5; r++) {
    for (let c = 1; c <= 8; c++) {
      dst.getRow(r).getCell(c).value = null;
      dst.getRow(r).getCell(c).font = { size: 10 };
    }
  }

  // Escribir — 8 cols: Fecha, Monto, Comercio, Tipo, Categoría, Subcategoría, Método, Banco
  rows.forEach((row, idx) => {
    const r = dst.getRow(3 + idx);
    r.getCell(1).value = row.fecha;
    r.getCell(2).value = row.monto;
    r.getCell(2).numFmt = '#,##0.00';
    r.getCell(3).value = row.comercio;
    r.getCell(4).value = row.tipo;
    r.getCell(5).value = row.categoria;
    r.getCell(6).value = row.subcategoria;
    r.getCell(7).value = row.metodo;
    r.getCell(8).value = row.banco;
  });

  const outPath = 'C:/Users/USUARIO/Downloads/plantilla_gastos_neto.xlsx';
  await wbDst.xlsx.writeFile(outPath);
  console.log('Generado:', outPath);
  console.log('Total:', rows.length, '(' + rows.filter(r => r.tipo === 'Gasto').length + ' gastos, ' + rows.filter(r => r.tipo === 'Ingreso').length + ' ingresos)');

  // Resumen subcategorías
  console.log('\nDesglose Categoría > Subcategoría:');
  const subCount = {};
  rows.forEach(r => {
    const key = r.categoria + ' > ' + r.subcategoria;
    subCount[key] = (subCount[key] || 0) + 1;
  });
  Object.entries(subCount).sort((a, b) => a[0].localeCompare(b[0])).forEach(([k, v]) => {
    console.log('  ' + k + ': ' + v + ' movs');
  });
}

main().catch(e => { console.error(e); process.exit(1); });
