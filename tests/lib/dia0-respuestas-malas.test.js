import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { calcularCuotaDiaria, diasHastaInclusive, analizarViabilidad } = require('../../services/metas');
const db = require('../../lib/db');

/**
 * Las respuestas malas del día 0 (plan día 0→1, 14-sep-2026) que viven en servicios puros. Los
 * casos de handler están en `lecturas-de-contenido.test.js` (metas, categoría) y en
 * `transacciones.test.js` (borrado sin sujeto).
 *
 * Dos arreglos se RETIRARON del mismo trabajo después de dos revisiones adversariales que
 * encontraron la misma clase dos veces (el rescate "4 en pan y maca" y el detector de "¿pierdo
 * mi registro?"): están en `docs/DEFECTOS.md` con el motivo. No los reconstruyas por regex.
 */

describe('diasHastaInclusive — por fecha de Lima, no por reloj del servidor', () => {
  it('una meta que vence hoy tiene 1 día', () => {
    expect(diasHastaInclusive('2026-09-14', '2026-09-14')).toBe(1);
  });
  it('cuenta los dos extremos', () => {
    expect(diasHastaInclusive('2026-09-24', '2026-09-14')).toBe(11);
    expect(diasHastaInclusive('2026-12-31', '2026-09-14')).toBe(109);
  });
  it('una fecha pasada da cero o menos', () => {
    expect(diasHastaInclusive('2026-09-13', '2026-09-14')).toBe(0);
  });
});

describe('calcularCuotaDiaria', () => {
  it('sin fecha no hay cuota por día', () => {
    expect(calcularCuotaDiaria(7000, 0, null)).toBeNull();
  });
  it('con la meta cumplida es cero', () => {
    expect(calcularCuotaDiaria(7000, 7000, '2099-12-31')).toBe(0);
  });
  // El control del 14-sep: el modelo dijo "S/233.33 por día" para S/7000 al 31-dic. Es ~S/65.
  it('S/7000 al 31-dic desde el 14-sep son S/65 por día', () => {
    expect(calcularCuotaDiaria(7000, 0, '2026-12-31', '2026-09-14')).toBe(65);
  });
  it('vence hoy: todo lo que falta, hoy', () => {
    expect(calcularCuotaDiaria(1000, 0, '2026-09-14', '2026-09-14')).toBe(1000);
  });
});

describe('analizarViabilidad — juzga con el último mes CERRADO', () => {
  const fromOriginal = db.supabase.from;
  afterEach(() => { db.supabase.from = fromOriginal; });

  const HOY = '2026-09-14';
  const DESDE_MES_PASADO = '2026-08-01';

  /** Doble mínimo: la primera transacción, y los ingresos/gastos elegidos por tipo. */
  function patchear({ primera, ingresos = 0, gastos = 0, errorPrimera = null, errorMes = null }) {
    const lecturas = [];
    db.supabase.from = (tabla) => {
      const filtros = [];
      let orden = null;
      const b = {};
      for (const op of ['select', 'eq', 'gte', 'lte', 'limit']) b[op] = (...a) => { filtros.push([op, ...a]); return b; };
      b.order = (col, o) => { orden = { col, ...o }; return b; };
      b.then = (ok, ko) => Promise.resolve().then(() => {
        const tipo = (filtros.find((f) => f[0] === 'eq' && f[1] === 'tipo') || [])[2];
        const desde = (filtros.find((f) => f[0] === 'gte' && f[1] === 'fecha') || [])[2];
        lecturas.push({ tabla, tipo, desde, orden });
        if (tabla === 'transacciones' && orden && orden.col === 'fecha' && orden.ascending === true && !tipo) {
          return errorPrimera ? { data: null, error: { message: errorPrimera } } : { data: primera ? [{ fecha: primera }] : [], error: null };
        }
        if (errorMes) return { data: null, error: { message: errorMes } };
        if (tabla === 'transacciones' && tipo === 'ingreso') return { data: ingresos ? [{ monto: ingresos, monto_pen: ingresos }] : [], error: null };
        if (tabla === 'transacciones' && tipo === 'gasto') return { data: gastos ? [{ monto: gastos, monto_pen: gastos }] : [], error: null };
        return { data: [], error: null };
      }).then(ok, ko);
      return b;
    };
    return lecturas;
  }

  // 2a917ac4, 27-ago-2026: su único ingreso del día 0 era S/17 → "extender el plazo 190 meses".
  it('el día 0 no opina, ni con el ingreso que haya entrado hoy', async () => {
    patchear({ primera: HOY, ingresos: 17 });
    const v = await analizarViabilidad('u', 3221, { restante: 7000, hoyStr: HOY });
    expect(v.viable).toBeNull();
    expect(v.sinHistorial).toBe(true);
    expect(v.mensaje).toMatch(/mes completo/);
    expect(v.mensaje).not.toMatch(/extender|meses/);
  });

  it('con el historial empezado A MITAD del mes pasado tampoco: ese mes no está entero', async () => {
    patchear({ primera: '2026-08-15', ingresos: 3000, gastos: 1000 });
    expect((await analizarViabilidad('u', 500, { hoyStr: HOY })).viable).toBeNull();
  });

  // Lo que encontró la segunda revisión: con umbral por antigüedad, un usuario de seis meses el
  // día 3 del mes (sueldo sin entrar) recibía "412 meses". El mes en curso no se mira.
  it('lee el mes pasado, no el que está corriendo', async () => {
    const lecturas = patchear({ primera: '2026-03-01', ingresos: 3000, gastos: 1000 });
    const v = await analizarViabilidad('u', 1500, { restante: 3000, hoyStr: '2026-09-03' });
    expect(v.viable).toBe(true);
    expect(v.mensaje).toMatch(/El mes pasado te quedaron libres S\/2000/);
    const delMes = lecturas.filter((l) => l.tipo);
    expect(delMes.length).toBe(2);
    for (const l of delMes) expect(l.desde).toBe(DESDE_MES_PASADO);
  });

  it('sin ingresos anotados el mes pasado no hay margen que medir: lo dice, no inventa un cero', async () => {
    patchear({ primera: '2026-03-01', ingresos: 0, gastos: 900 });
    const v = await analizarViabilidad('u', 300, { restante: 3000, hoyStr: HOY });
    expect(v.viable).toBeNull();
    expect(v.mensaje).toMatch(/ingresos/);
  });

  it('con margen chico dice en cuántos meses llega — no "extender"', async () => {
    patchear({ primera: '2026-03-01', ingresos: 1000, gastos: 800 });
    const v = await analizarViabilidad('u', 3221, { restante: 7000, hoyStr: HOY });
    expect(v.viable).toBe(false);
    expect(v.mensaje).toMatch(/llegarías en unos 35 meses/);   // 7000 / 200
    expect(v.mensaje).not.toMatch(/extender/);
  });

  it('con margen cero no inventa un plazo', async () => {
    patchear({ primera: '2026-03-01', ingresos: 500, gastos: 900 });
    const v = await analizarViabilidad('u', 300, { restante: 3000, hoyStr: HOY });
    expect(v.viable).toBe(false);
    expect(v.mensaje).toMatch(/no te quedó margen libre/);
  });

  it('enero mira diciembre del año anterior', async () => {
    const lecturas = patchear({ primera: '2025-01-01', ingresos: 3000, gastos: 1000 });
    await analizarViabilidad('u', 100, { hoyStr: '2026-01-10' });
    for (const l of lecturas.filter((x) => x.tipo)) expect(l.desde).toBe('2025-12-01');
  });

  it('si no puede leer el historial LANZA: "no pude leer" no es "no hay mes"', async () => {
    patchear({ primera: null, errorPrimera: 'statement timeout' });
    await expect(analizarViabilidad('u', 500, { hoyStr: HOY })).rejects.toThrow(/historial/);
  });

  it('si no puede leer el mes pasado LANZA', async () => {
    patchear({ primera: '2026-03-01', errorMes: 'statement timeout' });
    await expect(analizarViabilidad('u', 500, { hoyStr: HOY })).rejects.toThrow(/mes anterior/);
  });
});
