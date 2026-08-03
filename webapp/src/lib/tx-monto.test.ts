import { describe, it, expect } from 'vitest';
import { montoPen, formatTxMonto } from './tx-monto';
import { formatCurrency } from './utils';

// `transacciones.monto_pen` es NULLABLE a propósito. Estos tests fijan las dos
// cosas que se rompieron el 2026-08-03: el dashboard reventaba entero
// (`null.toLocaleString`) y, al arreglarlo, la tentación era pintar "S/ 0.00"
// para un gasto que sí existe.

describe('formatCurrency — piso de seguridad', () => {
  it('no revienta con null (era el crash del dashboard)', () => {
    expect(() => formatCurrency(null)).not.toThrow();
    expect(formatCurrency(null)).toBe('S/ —');
  });

  it('no revienta con undefined ni NaN', () => {
    expect(formatCurrency(undefined)).toBe('S/ —');
    expect(formatCurrency(NaN)).toBe('S/ —');
    expect(formatCurrency(Infinity)).toBe('S/ —');
  });

  it('respeta la moneda al reportar el hueco', () => {
    expect(formatCurrency(null, 'USD')).toBe('$ —');
  });

  it('sigue formateando normal lo que sí es número', () => {
    expect(formatCurrency(1234.5)).toBe('S/ 1,234.50');
    expect(formatCurrency(15.49, 'USD')).toBe('$ 15.49');
    expect(formatCurrency(0)).toBe('S/ 0.00');
  });
});

describe('montoPen — aritmética', () => {
  it('usa monto_pen cuando existe', () => {
    expect(montoPen({ monto: 15.49, monto_pen: 57.5, moneda: 'USD' })).toBe(57.5);
  });

  it('cae a monto cuando monto_pen es null (espeja `monto_pen || monto` del backend)', () => {
    expect(montoPen({ monto: 1.23, monto_pen: null, moneda: 'PEN' })).toBe(1.23);
  });

  it('un null en la lista no envenena la suma ni la borra', () => {
    const txs = [
      { monto: 100, monto_pen: 100, moneda: 'PEN' },
      { monto: 1.23, monto_pen: null, moneda: 'PEN' },
    ];
    const total = txs.reduce((s, t) => s + montoPen(t), 0);
    expect(total).toBe(101.23);
    expect(Number.isNaN(total)).toBe(false);
  });

  it('respeta el 0 legítimo en vez de tratarlo como ausente', () => {
    expect(montoPen({ monto: 50, monto_pen: 0, moneda: 'PEN' })).toBe(0);
  });
});

describe('formatTxMonto — display honesto', () => {
  it('pinta soles cuando hay conversión', () => {
    expect(formatTxMonto({ monto: 15.49, monto_pen: 57.5, moneda: 'USD' })).toBe('S/ 57.50');
  });

  it('sin monto_pen cae al monto original CON su moneda, no a soles inventados', () => {
    // La rama USD fuera de rango: sabemos que se gastaron $300k, no sabemos
    // a cuántos soles equivale. Pintar "S/ 300,000.00" sería mentir.
    expect(formatTxMonto({ monto: 300000, monto_pen: null, moneda: 'USD' })).toBe('$ 300,000.00');
  });

  it('nunca pinta S/ 0.00 para un gasto que existe', () => {
    const out = formatTxMonto({ monto: 1.23, monto_pen: null, moneda: 'PEN' });
    expect(out).toBe('S/ 1.23');
    expect(out).not.toContain('0.00');
  });

  it('sin moneda asume PEN (la columna es nullable en la DB)', () => {
    expect(formatTxMonto({ monto: 42, monto_pen: null, moneda: null })).toBe('S/ 42.00');
    expect(formatTxMonto({ monto: 42, monto_pen: null })).toBe('S/ 42.00');
  });

  it('no revienta con monto_pen null (el caso que tiraba el error boundary)', () => {
    expect(() => formatTxMonto({ monto: 1.23, monto_pen: null, moneda: 'PEN' })).not.toThrow();
  });
});
