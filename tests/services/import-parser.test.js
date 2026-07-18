import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseCSV, parseExcel } = require('../../services/import-parser');
const ExcelJS = require('exceljs');

describe('import-parser · parseCSV', () => {
  it('parsea un CSV simple con fecha/monto/descripción y normaliza DD/MM/YYYY', () => {
    const csv = 'Fecha,Monto,Descripción\n05/03/2026,50.00,Uber\n10/03/2026,120.50,Metro';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ fecha: '2026-03-05', monto: 50, comercio: 'Uber', tipo: 'gasto' });
    expect(rows[1]).toMatchObject({ fecha: '2026-03-10', monto: 120.5, comercio: 'Metro' });
  });

  it('normaliza fecha con año de 2 dígitos (DD/MM/YY → 20YY)', () => {
    const csv = 'fecha,monto,concepto\n01/01/26,10,Cafe';
    const rows = parseCSV(csv);
    expect(rows[0].fecha).toBe('2026-01-01');
  });

  it('detecta abono como ingreso y cargo como gasto', () => {
    const csv = 'Fecha;Cargo;Abono;Detalle\n05/03/2026;80;;Compra\n06/03/2026;;300;Sueldo';
    const rows = parseCSV(csv);
    expect(rows[0]).toMatchObject({ monto: 80, tipo: 'gasto', comercio: 'Compra' });
    expect(rows[1]).toMatchObject({ monto: 300, tipo: 'ingreso', comercio: 'Sueldo' });
  });

  it('auto-detecta separador punto y coma y limpia comillas', () => {
    const csv = '"Fecha";"Importe";"Movimiento"\n"05/03/2026";"1,234.50";"Plaza Vea"';
    const rows = parseCSV(csv);
    expect(rows[0]).toMatchObject({ monto: 1234.5, comercio: 'Plaza Vea', fecha: '2026-03-05' });
  });

  it('descarta filas con monto inválido, cero o negativo', () => {
    const csv = 'Fecha,Monto,Descripcion\n05/03/2026,0,Nada\n06/03/2026,-5,Negativo\n07/03/2026,abc,NaN\n08/03/2026,25,Valido';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].comercio).toBe('Valido');
  });

  it('trunca comercios largos a 100 caracteres', () => {
    const largo = 'X'.repeat(150);
    const csv = `Fecha,Monto,Descripcion\n05/03/2026,10,${largo}`;
    const rows = parseCSV(csv);
    expect(rows[0].comercio).toHaveLength(100);
  });

  it('lanza si el CSV está vacío (menos de 2 líneas)', () => {
    expect(() => parseCSV('Fecha,Monto,Desc')).toThrow(/vacío/);
  });

  it('lanza si no detecta columnas mínimas', () => {
    expect(() => parseCSV('ColA,ColB\n1,2')).toThrow(/No pude detectar las columnas/);
  });
});

describe('import-parser · parseExcel', () => {
  async function buildXlsx(headerRow, dataRows) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Gastos');
    ws.addRow(headerRow);
    dataRows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('parsea formato legacy6 (Fecha,Monto,Comercio,Categoría,Método,Banco)', async () => {
    const buf = await buildXlsx(
      ['Fecha', 'Monto', 'Comercio', 'Categoría', 'Método', 'Banco'],
      [['2026-03-05', 50, 'Uber', 'Transporte', 'Yape', 'BCP']],
    );
    const rows = await parseExcel(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fecha: '2026-03-05', monto: 50, comercio: 'Uber', tipo: 'gasto',
      categoria: 'Transporte', metodo_pago: 'Yape', banco: 'BCP',
    });
  });

  it('parsea formato full8 con Tipo ingreso y Subcategoría', async () => {
    const buf = await buildXlsx(
      ['Fecha', 'Monto', 'Comercio', 'Tipo', 'Categoría', 'Subcategoría', 'Método', 'Banco'],
      [['2026-03-06', 300, 'Sueldo', 'ingreso', 'Trabajo_Negocio', 'nomina', 'Transferencia', 'BBVA']],
    );
    const rows = await parseExcel(buf);
    expect(rows[0]).toMatchObject({
      tipo: 'ingreso', categoria: 'Trabajo_Negocio', subcategoria: 'nomina', comercio: 'Sueldo',
    });
  });

  it('descarta filas inválidas (sin comercio o monto <= 0)', async () => {
    const buf = await buildXlsx(
      ['Fecha', 'Monto', 'Comercio', 'Categoría', 'Método', 'Banco'],
      [
        ['2026-03-05', 0, 'Cero', 'Otros', '', ''],
        ['2026-03-06', 40, '', 'Otros', '', ''],
        ['2026-03-07', 25, 'Valido', 'Otros', '', ''],
      ],
    );
    const rows = await parseExcel(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].comercio).toBe('Valido');
  });

  it('lanza si el workbook no tiene hojas', async () => {
    const buf = Buffer.from(await new ExcelJS.Workbook().xlsx.writeBuffer());
    await expect(parseExcel(buf)).rejects.toThrow(/no tiene hojas/);
  });
});
