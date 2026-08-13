import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validarMonto } = require('../../lib/validators');

/**
 * `validarMonto` REDONDEA antes de decidir el signo, y ese orden es todo el test.
 *
 * Al revés —que es como estuvo— cualquier valor en (0, 0.005) pasaba el `> 0` y salía
 * redondeado a **0**: la función devolvía exactamente el valor que su propio docstring
 * dice que rechaza (*"un movimiento de S/0 no es un movimiento"*).
 *
 * Dos consecuencias medidas, y la segunda es la que más enseña:
 *
 *  - `POST /api/transactions {"monto": 0.001}` insertaba una transacción de S/0.
 *  - En deudas, el MISMO valor daba DOS respuestas distintas: el handler lo aceptaba
 *    como 0 y el servicio lo rechazaba lanzando, así que al usuario le salía "Ups, algo
 *    falló al registrar la deuda" — una caída de backend por un monto inválido.
 *
 * `qa-money-edge` no podía verlo: prueba el literal `0`, y con `0.001` pasa por al
 * lado. Lo encontró la segunda revisión adversarial del diff.
 *
 * Espejo de `webapp/src/lib/spaces-budgets.test.ts` (`parseMontoDinero`), que tiene el
 * mismo bloque: el bug vivía en las DOS copias, que es la clase `barrido-de-un-solo-arbol`
 * en versión validador.
 */
describe('validarMonto — el redondeo va ANTES del signo', () => {
  it('no devuelve 0 para un monto que redondea a 0', () => {
    for (const v of [0.001, 0.004, '0.001', 0.0049]) {
      expect(validarMonto(v), String(v)).toBeNull();
    }
  });

  it('el primer valor que SÍ redondea a un céntimo pasa', () => {
    expect(validarMonto(0.005)).toBe(0.01);
    expect(validarMonto(0.01)).toBe(0.01);
  });

  it('con permitirCero, el 0 legítimo pasa y el negativo real no', () => {
    // La cortesía Pro escribe `pagos.monto = 0`.
    expect(validarMonto(0, { permitirCero: true })).toBe(0);
    expect(validarMonto(0.001, { permitirCero: true })).toBe(0);
    expect(validarMonto(-0.001, { permitirCero: true })).toBe(0);
    expect(validarMonto(-1, { permitirCero: true })).toBeNull();
  });

  it('lo que ya rechazaba lo sigue rechazando', () => {
    for (const v of [NaN, Infinity, -Infinity, '1e999', 0, -5, 1000000, 'abc', null, undefined]) {
      expect(validarMonto(v), String(v)).toBeNull();
    }
  });

  it('el mismo valor da la MISMA respuesta en el handler y en el chokepoint', () => {
    // El síntoma del bug: `validarMonto('0.001')` daba 0 arriba y null abajo, así que
    // el flujo pasaba el guard del handler y moría lanzando en el servicio.
    const v = '0.001';
    expect(validarMonto(v)).toBe(validarMonto(validarMonto(v)));
  });
});
