import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizarTipo } = require('../../services/transactions');

/**
 * 28-ago-2026, visto en producción: `new row for relation "transacciones" violates check
 * constraint "transacciones_tipo_check"`. Un usuario, escaneo de Gmail.
 *
 * `guardarTransaccion` insertaba `tipo: datos.tipo || 'gasto'`, y ese `||` sólo cubre el vacío.
 * Lo que llega ahí es la salida CRUDA del modelo: ni `parsearCorreoBancario` ni
 * `parsearRegistroManual` validan lo que devuelven. Un `"Gasto"` con mayúscula o un
 * `"transferencia"` inventado viajaban tal cual hasta Postgres.
 *
 * Y el daño no es una fila mal tipada: el CHECK rechaza el INSERT entero, así que el movimiento
 * **no queda registrado**. El usuario pierde el gasto y no se entera.
 *
 * La normalización vive en `guardarTransaccion` porque es el único camino por el que nace una
 * transacción. El otro insert del repo (`handlers/intents/transacciones.js:942`) re-inserta un
 * snapshot que ya pasó por acá, así que no necesita el mismo arreglo — misma forma, distinto
 * problema.
 */

describe('normalizarTipo — el CHECK de la base no se puede violar desde acá', () => {
  it('deja pasar los dos valores canónicos', () => {
    expect(normalizarTipo('gasto')).toBe('gasto');
    expect(normalizarTipo('ingreso')).toBe('ingreso');
  });

  it('arregla la capitalización, que es lo que devuelve el modelo cuando se sale del molde', () => {
    expect(normalizarTipo('Gasto')).toBe('gasto');
    expect(normalizarTipo('INGRESO')).toBe('ingreso');
    expect(normalizarTipo('  Ingreso  ')).toBe('ingreso');
  });

  it('traduce los sinónimos con dirección inequívoca', () => {
    for (const v of ['egreso', 'salida', 'compra', 'pago', 'cargo', 'debito', 'débito']) {
      expect(normalizarTipo(v)).toBe('gasto');
    }
    for (const v of ['abono', 'entrada', 'deposito', 'depósito', 'credito', 'crédito']) {
      expect(normalizarTipo(v)).toBe('ingreso');
    }
  });

  it('NO adivina "transferencia", que puede ser entrada o salida', () => {
    // Es el caso que tienta a agregar un sinónimo más. Adivinarlo invierte el signo de la
    // plata en la mitad de los casos, y una dirección equivocada ensucia reportes,
    // presupuestos y score. Cae al default conservador como cualquier desconocido.
    expect(normalizarTipo('transferencia')).toBe('gasto');
  });

  it('cualquier valor desconocido cae en gasto en vez de reventar el insert', () => {
    for (const v of ['cualquier cosa', 'movimiento', '???', 'gastos', 'ingresos']) {
      expect(['gasto', 'ingreso']).toContain(normalizarTipo(v));
    }
  });

  it('conserva el comportamiento viejo para vacío, null y undefined', () => {
    // Control de no-regresión: esto ya funcionaba con el `|| 'gasto'` y tiene que seguir igual.
    for (const v of [undefined, null, '', '   ']) expect(normalizarTipo(v)).toBe('gasto');
  });

  it('nunca devuelve algo fuera del CHECK, sea cual sea la entrada', () => {
    // La propiedad que de verdad importa, y la única que la mutación no puede esquivar
    // agregando un caso más a la lista de sinónimos.
    const entradas = [
      'gasto', 'ingreso', 'Gasto', 'transferencia', 'x', '', null, undefined, 0, 1,
      {}, [], true, false, 'DROP TABLE', 'gasto ', ' INGRESO', 'égreso',
    ];
    for (const v of entradas) {
      expect(['gasto', 'ingreso']).toContain(normalizarTipo(v));
    }
  });
});
