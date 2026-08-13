import { describe, it, expect } from 'vitest';
import { parseSpaceAmount, parseSpaceBudgets, MAX_BUDGETS_POR_ESPACIO, MAX_MONTO } from './spaces-server';
import { parseMontoDinero } from './money';

/**
 * S′6 de la auditoría CTO del 2026-08-10.
 *
 * `PUT /api/spaces/[id]/budgets` validaba `Array.isArray(budgets)` y escribía el JSONB
 * tal cual. Era la única escritura de plata de Espacios que no pasaba por
 * `parseSpaceAmount`, y Espacios es donde menos red hay: las tablas `space_*` son
 * service-role-only por diseño (RLS deny-all), así que lo que no valida la ruta no lo
 * valida nadie.
 *
 * Adónde va a parar un límite corrupto: `dashboard/espacios/[id]` calcula
 * `budget.limit > 0 ? Math.round(spent / budget.limit * 100) : 0` para la barra, y
 * `budget.limit * frac` para lo que le toca a cada miembro. O sea que el número entra
 * a la pantalla de TODOS los miembros del espacio, no solo del que lo escribió.
 */

const bueno = { id: 'sbud-1', category: 'Transporte', limit: 300 };

describe('parseSpaceBudgets — lo válido pasa', () => {
  it('acepta un presupuesto bien formado y devuelve la forma cerrada', () => {
    const r = parseSpaceBudgets([bueno]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.budgets).toEqual([{ id: 'sbud-1', category: 'Transporte', limit: 300 }]);
  });

  it('acepta la lista vacía (borrar el último presupuesto)', () => {
    const r = parseSpaceBudgets([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.budgets).toEqual([]);
  });

  it('acepta el tope exacto de la columna', () => {
    const r = parseSpaceBudgets([{ ...bueno, limit: MAX_MONTO }]);
    expect(r.ok).toBe(true);
  });

  it('es la forma que hay HOY en producción (fila real de `shared_spaces`)', () => {
    // El único espacio con presupuesto en prod al 2026-08-13.
    const r = parseSpaceBudgets([{ id: 'sbud-1775247887250', limit: 300, category: 'Transporte' }]);
    expect(r.ok).toBe(true);
  });
});

describe('parseSpaceBudgets — LA prueba del hallazgo: el límite', () => {
  /**
   * `1e999` sobrevive a `JSON.parse` como Infinity y `isNaN(Infinity)` es false: es el
   * mismo vector que dejó abierto S2 en los aportes de metas, y el que `parseSpaceAmount`
   * existe para tapar. Peor acá: `JSON.stringify(Infinity)` es `null`, así que el JSONB
   * se quedaba con `limit: null` y la UI dividía contra null para siempre.
   */
  it.each([
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['NaN', NaN],
    ['cero', 0],
    ['negativo', -50],
    ['sobre el tope', 1_000_000],
    ['null', null],
    ['undefined', undefined],
    ['string no numérico', 'abc'],
    ['objeto', {}],
    ['array', [1]],
    ['booleano', true],
  ])('rechaza límite %s', (_label, limit) => {
    expect(parseSpaceBudgets([{ ...bueno, limit }]).ok).toBe(false);
  });

  it('rechaza el string "1e999", que es como llega por HTTP', () => {
    expect(parseSpaceBudgets([{ ...bueno, limit: '1e999' }]).ok).toBe(false);
  });

  it('un límite malo invalida la request ENTERA, no se cae solo esa fila', () => {
    // Si se descartara en silencio, el usuario vería "guardado" y el presupuesto que
    // acaba de escribir no estaría.
    const r = parseSpaceBudgets([bueno, { id: 'b2', category: 'Comida', limit: 'x' }]);
    expect(r.ok).toBe(false);
  });
});

describe('parseSpaceBudgets — la forma del resto del objeto', () => {
  it('rechaza lo que no es un array', () => {
    for (const raw of [null, undefined, {}, 'budgets', 5, true]) {
      expect(parseSpaceBudgets(raw).ok, String(raw)).toBe(false);
    }
  });

  it.each([null, undefined, 'texto', 5, [], true])('rechaza el item %j', (item) => {
    expect(parseSpaceBudgets([item]).ok).toBe(false);
  });

  it('rechaza categoría vacía, en blanco o que no es string', () => {
    for (const category of ['', '   ', null, undefined, 5, {}]) {
      expect(parseSpaceBudgets([{ ...bueno, category }]).ok, String(category)).toBe(false);
    }
  });

  it('rechaza una categoría absurdamente larga', () => {
    expect(parseSpaceBudgets([{ ...bueno, category: 'x'.repeat(200) }]).ok).toBe(false);
  });

  it('rechaza dos presupuestos con el MISMO id', () => {
    // La UI borra con `filter(b => b.id !== budget.id)`: dos ids iguales se borran de a
    // dos. La dedup por categoría no lo cubre — son dos categorías distintas.
    expect(parseSpaceBudgets([
      { id: 'x', category: 'Comida', limit: 10 },
      { id: 'x', category: 'Transporte', limit: 20 },
    ]).ok).toBe(false);
  });

  it('la dedup de categoría cruza unicode equivalente y no se engaña con invisibles', () => {
    // "Café" precompuesto (NFC) y descompuesto (NFD) se ven idénticos en pantalla.
    const nfc = 'Café';
    const nfd = 'Café';
    expect(nfc).not.toBe(nfd);
    expect(parseSpaceBudgets([
      { id: 'a', category: nfc, limit: 10 },
      { id: 'b', category: nfd, limit: 20 },
    ]).ok).toBe(false);
    // Un zero-width NO es whitespace: sobrevive a `trim()` y pasaba como categoría.
    expect(parseSpaceBudgets([{ id: 'a', category: '​﻿', limit: 10 }]).ok).toBe(false);
  });

  it('rechaza dos presupuestos para la misma categoría', () => {
    // La UI filtra las categorías ya presupuestadas, así que esto solo llega saltándose
    // la UI — pero dos filas iguales pintan dos barras para la misma plata.
    expect(parseSpaceBudgets([bueno, { id: 'b2', category: 'Transporte', limit: 100 }]).ok).toBe(false);
    expect(parseSpaceBudgets([bueno, { id: 'b2', category: 'transporte', limit: 100 }]).ok).toBe(false);
  });

  it('rechaza una lista sin cota (el JSONB se lee en cada visita al espacio)', () => {
    const muchos = Array.from({ length: MAX_BUDGETS_POR_ESPACIO + 1 }, (_, i) => ({
      id: `b${i}`, category: `Cat${i}`, limit: 10,
    }));
    expect(parseSpaceBudgets(muchos).ok).toBe(false);
    expect(parseSpaceBudgets(muchos.slice(0, MAX_BUDGETS_POR_ESPACIO)).ok).toBe(true);
  });

  it('no deja pasar llaves ajenas al JSONB', () => {
    const r = parseSpaceBudgets([{ ...bueno, esPro: true, __proto__: { x: 1 }, notas: 'x'.repeat(10000) }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.budgets[0]).sort()).toEqual(['category', 'id', 'limit']);
  });

  it('sin id usable cae a la categoría, no a undefined', () => {
    for (const id of [undefined, null, '', '   ', 42]) {
      const r = parseSpaceBudgets([{ category: 'Comida', limit: 100, id }]);
      expect(r.ok, String(id)).toBe(true);
      if (r.ok) expect(r.budgets[0].id).toBe('Comida');
    }
  });
});

/**
 * `parseSpaceAmount` NO es parte del hallazgo S′6 — es el validador que S′6 no estaba
 * usando. Pero lo cubre esta tanda porque el barrido de arriba le encontró un hueco
 * propio, y ese hueco no vive en `budgets` sino en las DOS rutas que ya lo usaban:
 * `POST /expenses` (mueve el balance real del grupo) y `POST /settle`.
 *
 * `Number(true) === 1` y `Number([1]) === 1`, así que `amount: true` pasaba como un
 * movimiento de S/1. Lo encontraron los tests, no la lectura del diff.
 */
describe('parseSpaceAmount — el tipo, no solo el valor', () => {
  it.each([true, false, [1], [], {}, null, undefined, () => 1])(
    'rechaza %j, que no es un monto que un cliente honesto mande', (raw) => {
      expect(parseSpaceAmount(raw)).toBeNull();
    }
  );

  it('sigue aceptando lo que SÍ mandan la UI y los harness', () => {
    expect(parseSpaceAmount(300)).toBe(300);
    expect(parseSpaceAmount('300')).toBe(300);
    expect(parseSpaceAmount('300.50')).toBe(300.5);
    expect(parseSpaceAmount(MAX_MONTO)).toBe(MAX_MONTO);
  });

  it('sigue rechazando lo que ya rechazaba', () => {
    for (const raw of ['1e999', Infinity, NaN, 0, -1, MAX_MONTO + 0.01, '', 'abc']) {
      expect(parseSpaceAmount(raw), String(raw)).toBeNull();
    }
  });
});

/**
 * `parseMontoDinero` REDONDEA antes de mirar el signo, y el orden es el bug.
 *
 * Al revés, todo lo que caía en (0, 0.005) pasaba el `> 0` y salía redondeado a **0**:
 * la función devolvía exactamente el valor que su contrato dice que rechaza, y
 * `POST /api/transactions {"monto": 0.001}` insertaba una transacción de S/0.
 * `qa-money-edge` no podía verlo porque prueba el literal `0`. Espejo del mismo test en
 * `tests/lib/validators-redondeo.test.js` — si se toca uno, el otro.
 */
describe('parseMontoDinero — el redondeo va ANTES del signo', () => {
  it('no devuelve 0 para un monto que redondea a 0', () => {
    for (const v of [0.001, 0.004, '0.001', 0.0049]) {
      expect(parseMontoDinero(v), String(v)).toBeNull();
    }
  });

  it('el primer valor que SÍ redondea a un céntimo pasa', () => {
    expect(parseMontoDinero(0.005)).toBe(0.01);
    expect(parseMontoDinero(0.01)).toBe(0.01);
  });

  it('con allowZero, el 0 legítimo sigue pasando y el negativo no', () => {
    expect(parseMontoDinero(0, { allowZero: true })).toBe(0);
    expect(parseMontoDinero(0.001, { allowZero: true })).toBe(0);
    expect(parseMontoDinero(-0.001, { allowZero: true })).toBe(0);
    expect(parseMontoDinero(-1, { allowZero: true })).toBeNull();
  });
});
