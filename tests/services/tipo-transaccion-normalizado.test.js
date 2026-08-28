import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { normalizarTipo } = require('../../services/transactions');
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

/**
 * El hash de dedup y el INSERT tienen que hablar del mismo tipo.
 *
 * `dedupRaw` se armaba con `datos.tipo || 'gasto'` —el valor CRUDO— mientras el insert
 * guardaba el normalizado. Mientras un `"Gasto"` con mayúscula reventaba el insert eso era
 * inalcanzable; la normalización lo volvió alcanzable, así que **lo introdujo este mismo
 * arreglo**: dos grafías del mismo tipo daban hashes distintos y el dedup dejaba de verlas
 * como duplicadas. Lo encontró una revisión del diff, no la suite.
 *
 * Hoy la divergencia es estructuralmente imposible: hay UNA variable (`tipoTx`) y la usan los
 * dos. Este guard es el tripwire de que siga siendo así, porque sin él revertir esa línea no
 * pone rojo absolutamente nada.
 *
 * Lo que NO cubre, dicho para que nadie lo lea como más de lo que es: mira el FUENTE, así que
 * no ejercita el insert, y una reintroducción escrita de otra forma (`datos['tipo']`,
 * desestructurar `const { tipo } = datos`) lo esquiva. Cubre la regresión realista, que es
 * alguien editando esa línea de vuelta a como estaba.
 */
describe('el tipo crudo entra a normalizarTipo y a ningún otro lado', () => {
  const fuente = readFileSync(join(RAIZ, 'services', 'transactions.js'), 'utf8');
  // Solo el código: los comentarios de este archivo nombran `datos.tipo` al explicar el bug.
  const codigo = fuente
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

  it('la única aparición de datos.tipo es como argumento de normalizarTipo', () => {
    const apariciones = codigo.match(/datos\s*(?:\.\s*tipo\b|\[\s*['"]tipo['"]\s*\])/g) || [];
    expect(apariciones.length).toBe(1);
    expect(codigo).toMatch(/normalizarTipo\(\s*datos\.tipo\s*,/);
  });

  it('el hash de dedup NO se arma con el valor crudo', () => {
    const lineaHash = codigo.split('\n').find((l) => l.includes('const dedupRaw'));
    expect(lineaHash).toBeTruthy();
    expect(lineaHash).not.toMatch(/datos\s*\.\s*tipo/);
    expect(lineaHash).toMatch(/tipoTx/);
  });

  it('el insert usa la MISMA variable que el hash, no otra llamada', () => {
    const lineaInsert = codigo.split('\n').find((l) => l.includes('usuario_id: usuarioId, tipo:'));
    expect(lineaInsert).toBeTruthy();
    expect(lineaInsert).toMatch(/tipo:\s*tipoTx\b/);
  });
});
