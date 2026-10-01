import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  resolverPeriodo,
  lunesDe,
  sumarDias,
  esFechaIso,
  etiquetaDia,
  MAX_DIAS_RANGO,
} from './periodo-reporte';

// Jueves 1-oct-2026. Fijo a propósito: el módulo no lee el reloj.
const HOY = '2026-10-01';

describe('lunesDe', () => {
  it('lleva cualquier día de la semana a su lunes', () => {
    expect(lunesDe('2026-09-28')).toBe('2026-09-28'); // lunes
    expect(lunesDe('2026-10-01')).toBe('2026-09-28'); // jueves
    expect(lunesDe('2026-10-04')).toBe('2026-09-28'); // domingo: es el ÚLTIMO día, no el primero
  });

  it('cruza de año', () => {
    expect(lunesDe('2027-01-03')).toBe('2026-12-28');
  });
});

describe('sumarDias / esFechaIso', () => {
  it('respeta el bisiesto', () => {
    expect(sumarDias('2028-02-28', 1)).toBe('2028-02-29');
    expect(sumarDias('2027-02-28', 1)).toBe('2027-03-01');
  });

  it('rechaza días que no existen y formatos sueltos', () => {
    expect(esFechaIso('2026-02-30')).toBe(false);
    expect(esFechaIso('2026-9-1')).toBe(false);
    expect(esFechaIso('hola')).toBe(false);
    expect(esFechaIso(null)).toBe(false);
    expect(esFechaIso('2028-02-29')).toBe(true);
  });
});

describe('resolverPeriodo: mes', () => {
  it('sin parámetros es el mes de hoy (Lima, el que pasa el llamador)', () => {
    const p = resolverPeriodo({}, HOY);
    expect(p.tipo).toBe('mes');
    expect([p.desde, p.hasta]).toEqual(['2026-10-01', '2026-11-01']);
    expect(p.previo).toEqual({ desde: '2026-09-01', hasta: '2026-10-01' });
    expect(p.dias).toHaveLength(31);
    expect(p.etiqueta).toBe('Octubre 2026');
  });

  it('?mes=YYYY-M mantiene el formato de siempre, y enero compara contra diciembre', () => {
    const p = resolverPeriodo({ mes: '2026-1' }, HOY);
    expect([p.desde, p.hasta]).toEqual(['2026-01-01', '2026-02-01']);
    expect(p.previo).toEqual({ desde: '2025-12-01', hasta: '2026-01-01' });
  });

  it('febrero bisiesto tiene 29 días', () => {
    expect(resolverPeriodo({ mes: '2028-2' }, HOY).dias).toHaveLength(29);
  });

  it('un mes inválido cae al mes de hoy', () => {
    expect(resolverPeriodo({ mes: '2026-13' }, HOY).desde).toBe('2026-10-01');
    expect(resolverPeriodo({ mes: 'basura' }, HOY).desde).toBe('2026-10-01');
    // Date.UTC lee los años 0-99 como 1900-1999: sin el mínimo salía desde "50-01-01".
    expect(resolverPeriodo({ mes: '0050-1' }, HOY).desde).toBe('2026-10-01');
  });

  it('las fechas anteriores a 2000 no se aceptan', () => {
    expect(esFechaIso('1999-12-31')).toBe(false);
    expect(resolverPeriodo({ desde: '1000-01-01', hasta: '2026-09-30' }, HOY).tipo).toBe('mes');
  });
});

describe('resolverPeriodo: semana', () => {
  it('cualquier día de la semana da la semana de lunes a domingo', () => {
    const p = resolverPeriodo({ semana: '2026-09-24' }, HOY); // jueves
    expect(p.tipo).toBe('semana');
    expect([p.desde, p.hasta]).toEqual(['2026-09-21', '2026-09-28']);
    expect(p.dias).toEqual([
      '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27',
    ]);
    expect(p.previo).toEqual({ desde: '2026-09-14', hasta: '2026-09-21' });
    expect(p.etiqueta).toBe('21 sep – 27 sep');
  });

  it('una semana que cruza de año lleva el año en las dos puntas', () => {
    const p = resolverPeriodo({ semana: '2026-12-31' }, '2027-02-01');
    expect([p.desde, p.hasta]).toEqual(['2026-12-28', '2027-01-04']);
    expect(p.etiqueta).toBe('28 dic 2026 – 3 ene 2027');
  });

  it('la semana en curso se compara contra los mismos días de la anterior', () => {
    // Jueves 1-oct: van 4 días (lun 28 a jue 1), así que el previo es lun 21 a jue 24.
    const p = resolverPeriodo({ semana: '2026-09-28' }, HOY);
    expect(p.previo).toEqual({ desde: '2026-09-21', hasta: '2026-09-25' });
    expect(p.etiquetaComparacion).toBe('vs los mismos días de la semana anterior');
    // El gráfico igual muestra la semana entera.
    expect(p.dias).toHaveLength(7);
  });

  it('el domingo la semana ya se compara entera', () => {
    const p = resolverPeriodo({ semana: '2026-09-28' }, '2026-10-04');
    expect(p.previo).toEqual({ desde: '2026-09-21', hasta: '2026-09-28' });
    expect(p.etiquetaComparacion).toBe('vs semana anterior');
  });

  it('una semana futura se lleva a la actual', () => {
    expect(resolverPeriodo({ semana: '2026-11-15' }, HOY).desde).toBe('2026-09-28');
  });

  it('le gana a ?mes', () => {
    expect(resolverPeriodo({ semana: '2026-09-28', mes: '2026-5' }, HOY).tipo).toBe('semana');
  });
});

describe('resolverPeriodo: rango', () => {
  it('la URL es inclusiva y hasta queda exclusivo', () => {
    const p = resolverPeriodo({ desde: '2026-09-25', hasta: '2026-09-30' }, HOY);
    expect(p.tipo).toBe('rango');
    expect([p.desde, p.hasta]).toEqual(['2026-09-25', '2026-10-01']);
    expect(p.dias).toHaveLength(6);
    // El previo tiene el mismo largo y termina donde empieza este.
    expect(p.previo).toEqual({ desde: '2026-09-19', hasta: '2026-09-25' });
    expect(p.recortado).toBe(false);
  });

  it('un solo día es un rango válido', () => {
    const p = resolverPeriodo({ desde: '2026-09-25', hasta: '2026-09-25' }, HOY);
    expect(p.dias).toEqual(['2026-09-25']);
    expect(p.previo).toEqual({ desde: '2026-09-24', hasta: '2026-09-25' });
  });

  it('las puntas invertidas se ordenan', () => {
    const p = resolverPeriodo({ desde: '2026-09-30', hasta: '2026-09-25' }, HOY);
    expect([p.desde, p.hasta]).toEqual(['2026-09-25', '2026-10-01']);
  });

  it('el final no pasa de hoy', () => {
    const p = resolverPeriodo({ desde: '2026-09-25', hasta: '2026-12-31' }, HOY);
    expect(p.hasta).toBe('2026-10-02');
  });

  it(`más de ${MAX_DIAS_RANGO} días se recorta conservando el final, y lo avisa`, () => {
    const p = resolverPeriodo({ desde: '2026-01-01', hasta: '2026-09-30' }, HOY);
    expect(p.dias).toHaveLength(MAX_DIAS_RANGO);
    expect(p.hasta).toBe('2026-10-01');
    expect(p.recortado).toBe(true);
  });

  it(`exactamente ${MAX_DIAS_RANGO} días no se recorta; uno más, sí`, () => {
    const justo = resolverPeriodo({ desde: sumarDias('2026-09-30', -(MAX_DIAS_RANGO - 1)), hasta: '2026-09-30' }, HOY);
    expect(justo.dias).toHaveLength(MAX_DIAS_RANGO);
    expect(justo.recortado).toBe(false);

    const unoMas = resolverPeriodo({ desde: sumarDias('2026-09-30', -MAX_DIAS_RANGO), hasta: '2026-09-30' }, HOY);
    expect(unoMas.dias).toHaveLength(MAX_DIAS_RANGO);
    expect(unoMas.recortado).toBe(true);
  });

  it('le gana a la semana; a medias o entero en el futuro no cuenta', () => {
    expect(resolverPeriodo({ desde: '2026-09-25', hasta: '2026-09-26', semana: '2026-09-01' }, HOY).tipo).toBe('rango');
    expect(resolverPeriodo({ desde: '2026-09-25' }, HOY).tipo).toBe('mes');
    expect(resolverPeriodo({ desde: '2026-11-01', hasta: '2026-11-05' }, HOY).tipo).toBe('mes');
  });
});

describe('etiquetaDia', () => {
  it('semana con día de la semana; mes con número; rango que cruza mes con día/mes', () => {
    expect(etiquetaDia(resolverPeriodo({ semana: '2026-09-28' }, HOY), '2026-10-01')).toBe('jue 1');
    expect(etiquetaDia(resolverPeriodo({ mes: '2026-9' }, HOY), '2026-09-07')).toBe('7');
    expect(etiquetaDia(resolverPeriodo({ desde: '2026-09-25', hasta: '2026-09-30' }, HOY), '2026-09-27')).toBe('27');
    expect(etiquetaDia(resolverPeriodo({ desde: '2026-09-25', hasta: '2026-10-01' }, HOY), '2026-10-01')).toBe('1/10');
  });
});

/**
 * El módulo hace aritmética de fechas en UTC a propósito. Con hora local, los tests pasaban
 * igual en Lima y en UTC (las zonas de la PC y del CI), y en una zona al este de UTC el
 * recorrido de días se colgaba: medido en la revisión del 01-oct-2026 con TZ=Asia/Tokyo. Este
 * bloque corre con esa zona para que una regresión así salga roja acá.
 */
describe('no depende de la zona horaria de la máquina', () => {
  const tzOriginal = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'Asia/Tokyo'; });
  afterAll(() => { process.env.TZ = tzOriginal; });

  it('la zona está aplicada (si no, este bloque no prueba nada)', () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(-540);
  });

  it('semana, días y bordes de mes salen igual en Tokio', () => {
    expect(lunesDe('2026-10-04')).toBe('2026-09-28');
    expect(sumarDias('2026-09-30', 1)).toBe('2026-10-01');
    const p = resolverPeriodo({ semana: '2026-12-31' }, '2027-02-01');
    expect([p.desde, p.hasta]).toEqual(['2026-12-28', '2027-01-04']);
    expect(p.dias).toHaveLength(7);
  });
});
