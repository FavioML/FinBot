import { describe, it, expect } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const APP = path.join(import.meta.dirname, '..', '..');
const { sumarMeses } = require(path.join(APP, 'lib', 'dates.js'));

// Regresión (2026-07-22): tres sitios sumaban meses con `Date.prototype.setMonth`, que
// desborda al mes siguiente cuando el día no existe en el destino (31-ene + 1 mes = 3-mar).
//   - services/referrals.js: el mes de Pro por referidos regalaba días.
//   - cron/checks.js: la próxima fecha de cobro perdía el día del mes de forma permanente
//     (el avance es iterativo) y el recordatorio dejaba de salir sin dejar rastro.
//   - handlers/intents/deudas.js: "en 1 mes" daba una fecha de vencimiento equivocada.
describe('sumarMeses', () => {
  it('recorta al último día cuando el día no existe en el mes destino', () => {
    // El caso que motivó todo. Con setMonth esto daba '2026-03-03'.
    expect(sumarMeses('2026-01-31', 1)).toBe('2026-02-28');
    expect(sumarMeses('2026-01-30', 1)).toBe('2026-02-28');
    expect(sumarMeses('2026-01-29', 1)).toBe('2026-02-28');
    expect(sumarMeses('2026-03-31', 1)).toBe('2026-04-30');
    expect(sumarMeses('2026-05-31', 1)).toBe('2026-06-30');
  });

  it('respeta los años bisiestos', () => {
    expect(sumarMeses('2028-01-31', 1)).toBe('2028-02-29'); // 2028 es bisiesto
    expect(sumarMeses('2026-01-31', 1)).toBe('2026-02-28'); // 2026 no lo es
    expect(sumarMeses('2028-02-29', 12)).toBe('2029-02-28');
  });

  it('preserva el día del mes cuando sí existe', () => {
    expect(sumarMeses('2026-01-15', 1)).toBe('2026-02-15');
    expect(sumarMeses('2026-01-31', 2)).toBe('2026-03-31');
    expect(sumarMeses('2026-06-30', 1)).toBe('2026-07-30');
  });

  it('cruza el fin de año en ambos sentidos', () => {
    expect(sumarMeses('2026-12-15', 1)).toBe('2027-01-15');
    expect(sumarMeses('2026-11-30', 3)).toBe('2027-02-28');
    expect(sumarMeses('2026-01-15', -1)).toBe('2025-12-15');
    expect(sumarMeses('2026-03-31', -1)).toBe('2026-02-28');
  });

  it('acepta timestamps y se queda con la parte de fecha', () => {
    expect(sumarMeses('2026-01-31T05:00:00.000Z', 1)).toBe('2026-02-28');
  });

  it('rechaza una fecha inválida en vez de devolver NaN', () => {
    expect(() => sumarMeses('no-es-fecha', 1)).toThrow(/fecha inválida/);
    expect(() => sumarMeses(null, 1)).toThrow(/fecha inválida/);
  });

  it('no desborda nunca: para todo día 29-31 el resultado se queda en el mes destino', () => {
    // Barrido exhaustivo del año: el mes del resultado tiene que ser exactamente el
    // siguiente. Esta es la propiedad que setMonth rompía.
    for (let mes = 1; mes <= 12; mes++) {
      for (const dia of [29, 30, 31]) {
        const ultimo = new Date(2026, mes, 0).getDate();
        if (dia > ultimo) continue;
        const origen = '2026-' + String(mes).padStart(2, '0') + '-' + dia;
        const [y, m] = sumarMeses(origen, 1).split('-').map(Number);
        const esperado = mes === 12 ? { y: 2027, m: 1 } : { y: 2026, m: mes + 1 };
        expect({ y, m }, origen + ' + 1 mes se salió del mes destino').toEqual(esperado);
      }
    }
  });
});

// El avance iterativo del cron de suscripciones (cron/checks.js). Antes, un cobro del 31
// perdía el día en el primer salto y no lo recuperaba nunca: 31-ene -> 3-mar -> 3-abr...
describe('avance mes a mes de la fecha de cobro', () => {
  function proximoCobro(ultimoPago, hoyISO) {
    const hoy = new Date(hoyISO + 'T12:00:00');
    let meses = 1;
    let next = new Date(sumarMeses(ultimoPago, meses) + 'T12:00:00');
    while (next < hoy && meses < 25) {
      meses++;
      next = new Date(sumarMeses(ultimoPago, meses) + 'T12:00:00');
    }
    return next.toISOString().slice(0, 10);
  }

  it('vuelve al día 31 en los meses que lo tienen', () => {
    expect(proximoCobro('2026-01-31', '2026-02-01')).toBe('2026-02-28');
    expect(proximoCobro('2026-01-31', '2026-03-01')).toBe('2026-03-31'); // recuperado
    expect(proximoCobro('2026-01-31', '2026-04-01')).toBe('2026-04-30');
    expect(proximoCobro('2026-01-31', '2026-05-01')).toBe('2026-05-31'); // recuperado
  });

  it('un cobro a mitad de mes avanza sin sorpresas', () => {
    expect(proximoCobro('2026-01-15', '2026-04-20')).toBe('2026-05-15');
  });
});
