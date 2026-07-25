import { describe, it, expect } from 'vitest';
import { parseMontoDinero } from './money';

// Ancla el contrato del validador de montos: los límites válidos pasan, y los
// inputs que envenenaban las rutas de edición (Infinity → null → NaN, sin tope,
// negativos) se rechazan. Si alguien afloja el guard, esta suite lo delata.
describe('parseMontoDinero', () => {
  it('acepta los límites válidos', () => {
    expect(parseMontoDinero(0.01)).toBe(0.01);
    expect(parseMontoDinero(999999.99)).toBe(999999.99);
    expect(parseMontoDinero(50)).toBe(50);
    expect(parseMontoDinero('123.456')).toBe(123.46); // redondea a 2 decimales
    expect(parseMontoDinero('500')).toBe(500); // strings numéricos del body JSON
  });

  it('rechaza montos sobre el tope de la columna NUMERIC', () => {
    expect(parseMontoDinero(1000000)).toBeNull();
    expect(parseMontoDinero(1_000_000.01)).toBeNull();
  });

  it('rechaza Infinity (el vector que envenenaba deudas: Infinity → null → NaN)', () => {
    expect(parseMontoDinero(Infinity)).toBeNull();
    expect(parseMontoDinero(-Infinity)).toBeNull();
    expect(parseMontoDinero(parseFloat('1e999'))).toBeNull(); // parseFloat('1e999') === Infinity
  });

  it('rechaza NaN y texto no numérico', () => {
    expect(parseMontoDinero(NaN)).toBeNull();
    expect(parseMontoDinero('abc')).toBeNull();
    expect(parseMontoDinero('')).toBeNull();
    expect(parseMontoDinero(null)).toBeNull();
    expect(parseMontoDinero(undefined)).toBeNull();
  });

  it('rechaza negativos y cero por defecto', () => {
    expect(parseMontoDinero(-5)).toBeNull();
    expect(parseMontoDinero(0)).toBeNull();
    expect(parseMontoDinero(-0.01)).toBeNull();
  });

  it('con allowZero acepta 0 (saldos acumulados) pero sigue rechazando negativos e inválidos', () => {
    expect(parseMontoDinero(0, { allowZero: true })).toBe(0);
    expect(parseMontoDinero(100, { allowZero: true })).toBe(100);
    expect(parseMontoDinero(-5, { allowZero: true })).toBeNull();
    expect(parseMontoDinero(Infinity, { allowZero: true })).toBeNull();
    expect(parseMontoDinero(1000000, { allowZero: true })).toBeNull();
  });
});
