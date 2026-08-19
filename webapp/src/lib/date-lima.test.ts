import { describe, it, expect } from 'vitest';
import { monthWindowLima, startOfMonthLima, msDeFechaLima } from './date-lima';

/**
 * Las aserciones son instantes UTC absolutos a propósito: es la única forma de que este
 * archivo pruebe algo. El bug que cierra `monthWindowLima` no se reproduce en la máquina de
 * Favio —que corre en TZ Lima, donde `new Date(y, m + 1, 0, 23, 59, 59)` sí da medianoche
 * Lima— y sí en Vercel, donde el proceso corre en UTC y ese mismo constructor devuelve las
 * **18:59:59 de Lima**. Un test que se apoyara en la zona del proceso pasaría en los dos
 * lados sin mirar nada.
 */
describe('monthWindowLima', () => {
  // Lima 00:00 del 1 de agosto = 05:00 UTC. El fin es un ms antes del mismo instante del
  // mes siguiente, o sea 04:59:59.999 UTC del 1 de septiembre = 23:59:59.999 Lima del 31.
  it('la ventana empieza y termina a medianoche LIMA, no del servidor', () => {
    const { start, end } = monthWindowLima(new Date('2026-08-18T12:00:00Z'), 0);
    expect(start.toISOString()).toBe('2026-08-01T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-01T04:59:59.999Z');
  });

  // El caso que producía el error: una baja el 31-ago a las 23:00 de Lima es
  // 2026-09-01T04:00:00Z. Con el fin de mes en las 18:59:59 Lima quedaba FUERA de agosto.
  it('las últimas cinco horas del último día Lima caen dentro de su mes', () => {
    const { end } = monthWindowLima(new Date('2026-08-18T12:00:00Z'), 0);
    const bajaTardeDelUltimoDia = new Date('2026-09-01T04:00:00Z'); // 31-ago 23:00 Lima
    expect(bajaTardeDelUltimoDia <= end).toBe(true);
  });

  it('el mes en curso arranca donde startOfMonthLima', () => {
    const ahora = new Date('2026-08-18T12:00:00Z');
    expect(monthWindowLima(ahora, 0).start.toISOString()).toBe(
      startOfMonthLima(ahora).toISOString(),
    );
  });

  it('retrocede meses y cruza el año sin caso especial', () => {
    const ahora = new Date('2026-02-10T12:00:00Z');
    const { start, end, label } = monthWindowLima(ahora, 2); // diciembre 2025
    expect(start.toISOString()).toBe('2025-12-01T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-01-01T04:59:59.999Z');
    expect(label).toContain('25');
  });

  // La etiqueta se formateaba desde el inicio de mes con `timeZone: 'America/Lima'`, que lo
  // corre a las 19:00 del último día del mes ANTERIOR: el bucket con el MRR vivo salía
  // rotulado con el mes pasado. Ese chart es justo donde se lee la caída de las bajas.
  it('la etiqueta nombra el mes de la ventana, no el anterior', () => {
    const { label } = monthWindowLima(new Date('2026-08-18T12:00:00Z'), 0);
    expect(label.toLowerCase()).toContain('ago');
  });

  it('un día 1 temprano en Lima todavía pertenece a su mes', () => {
    // 2026-08-01T06:00:00Z = 01:00 Lima del 1 de agosto.
    const { label, start } = monthWindowLima(new Date('2026-08-01T06:00:00Z'), 0);
    expect(label.toLowerCase()).toContain('ago');
    expect(start.toISOString()).toBe('2026-08-01T05:00:00.000Z');
  });

  // Y un instante de las 03:00 UTC del 1 de agosto es todavía el 31 de JULIO en Lima.
  it('la madrugada UTC del día 1 sigue siendo el mes anterior en Lima', () => {
    const { start, label } = monthWindowLima(new Date('2026-08-01T03:00:00Z'), 0);
    expect(start.toISOString()).toBe('2026-07-01T05:00:00.000Z');
    expect(label.toLowerCase()).toContain('jul');
  });
});

describe('msDeFechaLima', () => {
  // Una columna DATE nombra un dia calendario peruano, no un instante UTC. Sin esto vive
  // cinco horas antes del borde del mes Lima y el dia 1 se cae al mes anterior.
  it('una DATE es la medianoche de LIMA de ese dia', () => {
    expect(new Date(msDeFechaLima('2026-08-01')).toISOString()).toBe('2026-08-01T05:00:00.000Z');
  });

  it('cae dentro de la ventana de SU mes, no de la anterior', () => {
    const ago = monthWindowLima(new Date('2026-08-18T12:00:00Z'), 0);
    const jul = monthWindowLima(new Date('2026-08-18T12:00:00Z'), 1);
    const t = msDeFechaLima('2026-08-01');
    expect(t >= ago.start.getTime() && t <= ago.end.getTime()).toBe(true);
    expect(t <= jul.end.getTime()).toBe(false);
  });

  it('un timestamp completo conserva su zona', () => {
    expect(msDeFechaLima('2026-08-01T09:30:00Z')).toBe(new Date('2026-08-01T09:30:00Z').getTime());
  });

  it('lo ilegible es NaN, no un cero', () => {
    expect(Number.isNaN(msDeFechaLima('no-es-fecha'))).toBe(true);
    expect(Number.isNaN(msDeFechaLima(null))).toBe(true);
  });
});
