import { describe, it, expect } from 'vitest';
import {
  splitFractions,
  resolveSplit,
  sanitizeSplitRules,
} from '../../webapp/src/lib/spaces-split.ts';

/**
 * El motor de division de gastos compartidos mueve plata real entre personas.
 * El invariante que protege esta suite: para cualquier lista de miembros no
 * vacia, las fracciones suman 1. Si suman menos, el que pago queda acreditado
 * por plata que nadie debe (dinero fantasma que ningun settlement reconcilia);
 * si suman mas, al grupo se le cobra de mas.
 */

const sum = (fractions) => Object.values(fractions).reduce((s, v) => s + v, 0);

const members = (...entries) =>
  entries.map(([user_id, split_percentage]) => ({ user_id, split_percentage }));

describe('splitFractions', () => {
  it('divide segun el split por defecto y suma 1', () => {
    const ms = members(['a', 50], ['b', 50]);
    const f = splitFractions('Comida', ms, []);
    expect(f.a).toBeCloseTo(0.5);
    expect(f.b).toBeCloseTo(0.5);
    expect(sum(f)).toBeCloseTo(1);
  });

  it('respeta pesos desiguales del split por defecto', () => {
    const ms = members(['a', 70], ['b', 30]);
    const f = splitFractions(null, ms, []);
    expect(f.a).toBeCloseTo(0.7);
    expect(f.b).toBeCloseTo(0.3);
    expect(sum(f)).toBeCloseTo(1);
  });

  it('una regla por categoria manda sobre el split por defecto', () => {
    const ms = members(['a', 50], ['b', 50]);
    const rules = [{ id: 'r1', category: 'Comida', splits: { a: 80, b: 20 } }];
    const f = splitFractions('Comida', ms, rules);
    expect(f.a).toBeCloseTo(0.8);
    expect(f.b).toBeCloseTo(0.2);
    expect(sum(f)).toBeCloseTo(1);
  });

  it('la regla no aplica a otras categorias', () => {
    const ms = members(['a', 50], ['b', 50]);
    const rules = [{ id: 'r1', category: 'Comida', splits: { a: 80, b: 20 } }];
    const f = splitFractions('Transporte', ms, rules);
    expect(f.a).toBeCloseTo(0.5);
    expect(sum(f)).toBeCloseTo(1);
  });

  // --- B1: la regresion que motivo este modulo ---
  it('B1: ignora el peso de un miembro removido y sigue sumando 1', () => {
    // La regla nombraba a "m", que despues salio del espacio. Su peso quedo en
    // split_rules (removerlo del espacio no limpia las reglas). Antes del fix el
    // denominador lo contaba: a recibia 50/100 = 0.5 y el total quedaba en 0.5,
    // dejando la mitad del gasto sin deudor.
    const ms = members(['a', 50]);
    const rules = [{ id: 'r1', category: 'Comida', splits: { a: 50, m: 50 } }];
    const f = splitFractions('Comida', ms, rules);
    expect(f.a).toBeCloseTo(1);
    expect(f.m).toBeUndefined();
    expect(sum(f)).toBeCloseTo(1);
  });

  it('B1: con miembros restantes reparte solo entre ellos', () => {
    const ms = members(['a', 50], ['b', 50]);
    const rules = [{ id: 'r1', category: 'Comida', splits: { a: 25, b: 25, m: 50 } }];
    const f = splitFractions('Comida', ms, rules);
    expect(f.a).toBeCloseTo(0.5);
    expect(f.b).toBeCloseTo(0.5);
    expect(sum(f)).toBeCloseTo(1);
  });

  it('si la regla no nombra a ningun miembro actual, cae al split por defecto', () => {
    const ms = members(['a', 70], ['b', 30]);
    const rules = [{ id: 'r1', category: 'Comida', splits: { fantasma: 100 } }];
    const f = splitFractions('Comida', ms, rules);
    expect(f.a).toBeCloseTo(0.7);
    expect(f.b).toBeCloseTo(0.3);
    expect(sum(f)).toBeCloseTo(1);
  });

  it('un miembro fuera de la regla recibe 0, no el split por defecto', () => {
    // Semantica unificada cliente/servidor (B2): la regla define quienes comparten
    // esa categoria. Darle el default al ausente haria que las fracciones sumen >1.
    const ms = members(['a', 50], ['b', 50], ['c', 50]);
    const rules = [{ id: 'r1', category: 'Comida', splits: { a: 50, b: 50 } }];
    const f = splitFractions('Comida', ms, rules);
    expect(f.c).toBe(0);
    expect(sum(f)).toBeCloseTo(1);
  });

  it('neutraliza pesos corruptos (Infinity / NaN / negativos)', () => {
    const ms = members(['a', 50], ['b', 50]);
    const rules = [{ id: 'r1', category: 'Comida', splits: { a: Infinity, b: 50 } }];
    const f = splitFractions('Comida', ms, rules);
    expect(Number.isFinite(sum(f))).toBe(true);
    expect(sum(f)).toBeCloseTo(1);
    expect(f.a).toBe(0);
    expect(f.b).toBeCloseTo(1);
  });

  it('sin split_percentage util reparte en partes iguales', () => {
    const ms = members(['a', 0], ['b', null]);
    const f = splitFractions(null, ms, []);
    expect(f.a).toBeCloseTo(0.5);
    expect(f.b).toBeCloseTo(0.5);
    expect(sum(f)).toBeCloseTo(1);
  });

  it('sin miembros devuelve vacio sin explotar', () => {
    expect(splitFractions('Comida', [], [])).toEqual({});
  });
});

describe('resolveSplit (lo que ve el usuario)', () => {
  it('B2: coincide exactamente con el motor de balances', () => {
    // La divergencia original: el cliente daba el default a un miembro ausente de
    // la regla y el servidor le daba 0, asi que la "tu parte" mostrada nunca
    // cuadraba con el saldo cobrado.
    const ms = members(['a', 50], ['b', 30], ['c', 20]);
    const rules = [{ id: 'r1', category: 'Comida', splits: { a: 60, b: 40 } }];
    const fractions = splitFractions('Comida', ms, rules);
    for (const m of ms) {
      expect(resolveSplit('Comida', m.user_id, ms, rules)).toBeCloseTo(fractions[m.user_id]);
    }
  });

  it('devuelve 0 para un usuario que no es miembro', () => {
    const ms = members(['a', 50], ['b', 50]);
    expect(resolveSplit('Comida', 'extrano', ms, [])).toBe(0);
  });
});

describe('sanitizeSplitRules', () => {
  const memberIds = new Set(['a', 'b']);

  it('descarta pesos de usuarios que no son miembros', () => {
    const clean = sanitizeSplitRules(
      [{ id: 'r1', category: 'Comida', splits: { a: 50, b: 50, fantasma: 1000 } }],
      memberIds
    );
    expect(clean[0].splits).toEqual({ a: 50, b: 50 });
  });

  it('descarta pesos no finitos o negativos', () => {
    const clean = sanitizeSplitRules(
      [{ id: 'r1', category: 'Comida', splits: { a: Infinity, b: 40 } }],
      memberIds
    );
    expect(clean[0].splits).toEqual({ b: 40 });
  });

  it('capa los pesos a 100', () => {
    const clean = sanitizeSplitRules(
      [{ id: 'r1', category: 'Comida', splits: { a: 5000, b: 50 } }],
      memberIds
    );
    expect(clean[0].splits.a).toBe(100);
  });

  it('descarta reglas que quedarian sin ningun peso util', () => {
    const clean = sanitizeSplitRules(
      [{ id: 'r1', category: 'Comida', splits: { fantasma: 100 } }],
      memberIds
    );
    expect(clean).toEqual([]);
  });

  it('descarta entradas malformadas sin explotar', () => {
    const clean = sanitizeSplitRules(
      [null, 'texto', { category: '' }, { id: 'ok', category: 'Comida', splits: { a: 50 } }],
      memberIds
    );
    expect(clean).toHaveLength(1);
    expect(clean[0].category).toBe('Comida');
  });

  it('no acepta cualquier cosa que no sea un array', () => {
    expect(sanitizeSplitRules(null, memberIds)).toEqual([]);
    expect(sanitizeSplitRules({ a: 1 }, memberIds)).toEqual([]);
  });

  it('una regla saneada mantiene el invariante de suma 1', () => {
    const clean = sanitizeSplitRules(
      [{ id: 'r1', category: 'Comida', splits: { a: 50, b: 50, fantasma: 900 } }],
      memberIds
    );
    const f = splitFractions('Comida', members(['a', 50], ['b', 50]), clean);
    expect(sum(f)).toBeCloseTo(1);
  });
});
