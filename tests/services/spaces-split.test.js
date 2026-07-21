import { describe, it, expect } from 'vitest';
import {
  splitFractions,
  resolveSplit,
  sanitizeSplitRules,
  simplifyDebts,
  allocateShares,
  buildSplitSnapshot,
  computeBalancesFromSnapshots,
  shareCents,
  toCents,
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

describe('simplifyDebts', () => {
  const totalMovido = (ts) => ts.reduce((s, t) => s + t.amount, 0);

  it('caso de pareja: un deudor, un acreedor', () => {
    const ts = simplifyDebts({ a: -50, b: 50 });
    expect(ts).toEqual([{ from: 'a', to: 'b', amount: 50 }]);
  });

  it('balances saldados no generan transferencias', () => {
    expect(simplifyDebts({ a: 0, b: 0 })).toEqual([]);
  });

  // --- F4: la regresion. Con 3+ miembros el codigo viejo imputaba a cada deudor
  // su saldo entero contra el PRIMER acreedor, inventando plata que ese acreedor
  // nunca puso.
  it('F4: con dos acreedores no le cobra todo al primero', () => {
    const ts = simplifyDebts({ deudor: -100, acreedor1: 60, acreedor2: 40 });
    const cobraA1 = ts.filter((t) => t.to === 'acreedor1').reduce((s, t) => s + t.amount, 0);
    const cobraA2 = ts.filter((t) => t.to === 'acreedor2').reduce((s, t) => s + t.amount, 0);
    expect(cobraA1).toBeCloseTo(60);
    expect(cobraA2).toBeCloseTo(40);
    expect(totalMovido(ts)).toBeCloseTo(100);
  });

  it('F4: ningun acreedor recibe mas de lo que se le debe', () => {
    const balances = { d1: -70, d2: -30, c1: 80, c2: 20 };
    const ts = simplifyDebts(balances);
    for (const [userId, saldo] of Object.entries(balances)) {
      if (saldo <= 0) continue;
      const recibe = ts.filter((t) => t.to === userId).reduce((s, t) => s + t.amount, 0);
      expect(recibe).toBeLessThanOrEqual(saldo + 0.01);
    }
  });

  it('cada deudor paga exactamente lo que debe', () => {
    const balances = { d1: -70, d2: -30, c1: 80, c2: 20 };
    const ts = simplifyDebts(balances);
    for (const [userId, saldo] of Object.entries(balances)) {
      if (saldo >= 0) continue;
      const paga = ts.filter((t) => t.from === userId).reduce((s, t) => s + t.amount, 0);
      expect(paga).toBeCloseTo(-saldo);
    }
  });

  it('no genera mas de (miembros - 1) transferencias', () => {
    const balances = { a: -40, b: -35, c: -25, d: 60, e: 40 };
    const ts = simplifyDebts(balances);
    expect(ts.length).toBeLessThanOrEqual(Object.keys(balances).length - 1);
    expect(totalMovido(ts)).toBeCloseTo(100);
  });

  it('ignora saldos por debajo del epsilon (ruido de centavos)', () => {
    const ts = simplifyDebts({ a: -0.004, b: 0.004 });
    expect(ts).toEqual([]);
  });

  it('termina aunque los balances no cierren en cero', () => {
    // Defensivo: no debe colgarse si por un redondeo la suma no da exactamente 0.
    const ts = simplifyDebts({ a: -100, b: 30 });
    expect(totalMovido(ts)).toBeCloseTo(30);
  });
});

describe('allocateShares (el redondeo a centavos)', () => {
  const sumaCentavos = (shares) => Object.values(shares).reduce((s, v) => s + v, 0);

  it('S/100 entre tres suma exactamente 10000 centavos', () => {
    // El caso que rompe el reparto ingenuo: 33.33 x 3 = 99.99 y falta un centavo.
    const shares = allocateShares(10000, { a: 1 / 3, b: 1 / 3, c: 1 / 3 });
    expect(sumaCentavos(shares)).toBe(10000);
    expect(Object.values(shares).sort()).toEqual([3333, 3333, 3334]);
  });

  it('un centavo entre seis se lo lleva uno solo, sin inventar centavos', () => {
    const fractions = {};
    for (const id of 'abcdef') fractions[id] = 1 / 6;
    const shares = allocateShares(1, fractions);
    expect(sumaCentavos(shares)).toBe(1);
    expect(Object.values(shares).filter((c) => c === 1)).toHaveLength(1);
  });

  it('el monto tope de la API se reparte exacto', () => {
    const fractions = {};
    for (const id of 'abcdef') fractions[id] = 1 / 6;
    expect(sumaCentavos(allocateShares(toCents(999999.99), fractions))).toBe(99999999);
  });

  it('es determinista: mismo input, mismo reparto, corra donde corra', () => {
    const fractions = { zeta: 1 / 3, alfa: 1 / 3, mu: 1 / 3 };
    const primera = allocateShares(10000, fractions);
    for (let i = 0; i < 20; i++) expect(allocateShares(10000, fractions)).toEqual(primera);
    // Empate perfecto de restos: gana el user_id menor, no el orden de inserción.
    expect(primera.alfa).toBe(3334);
  });

  it('un miembro con fraccion 0 no recibe centavos de propina', () => {
    const shares = allocateShares(10000, { a: 0.5, b: 0.5, c: 0 });
    expect(shares.c).toBe(0);
    expect(sumaCentavos(shares)).toBe(10000);
  });

  it('nunca produce partes negativas', () => {
    const shares = allocateShares(777, { a: 0.5, b: 0.3, c: 0.2 });
    for (const c of Object.values(shares)) expect(c).toBeGreaterThanOrEqual(0);
    expect(sumaCentavos(shares)).toBe(777);
  });

  it('monto cero reparte ceros', () => {
    expect(sumaCentavos(allocateShares(0, { a: 0.5, b: 0.5 }))).toBe(0);
  });

  it('sin fracciones no reparte nada', () => {
    expect(allocateShares(10000, {})).toEqual({});
  });
});

describe('buildSplitSnapshot (congelar la division)', () => {
  const total = (snap) => snap.shares.reduce((s, x) => s + x.cents, 0);

  it('marca la procedencia cuando manda una regla', () => {
    const ms = members(['a', 50], ['b', 50]);
    const rules = [{ id: 'r1', category: 'Comida', splits: { a: 70, b: 30 } }];
    const snap = buildSplitSnapshot(100, 'Comida', ms, rules);
    expect(snap.source).toBe('rule');
    expect(snap.rule_id).toBe('r1');
    expect(shareCents(snap, 'a')).toBe(7000);
    expect(total(snap)).toBe(10000);
  });

  it('marca default cuando no hay regla aplicable', () => {
    const ms = members(['a', 50], ['b', 50]);
    const snap = buildSplitSnapshot(100, 'Transporte', ms, [
      { id: 'r1', category: 'Comida', splits: { a: 70, b: 30 } },
    ]);
    expect(snap.source).toBe('default');
    expect(snap.rule_id).toBeUndefined();
    expect(total(snap)).toBe(10000);
  });

  it('el snapshot congela: cambiar la regla despues no lo toca', () => {
    // La razon de existir de toda esta pieza. Antes, editar la regla reescribia
    // lo que cada quien debia en gastos de hace meses.
    const ms = members(['a', 50], ['b', 50]);
    const snap = buildSplitSnapshot(100, 'Comida', ms, [
      { id: 'r1', category: 'Comida', splits: { a: 70, b: 30 } },
    ]);
    const congelado = JSON.parse(JSON.stringify(snap));
    buildSplitSnapshot(100, 'Comida', ms, [
      { id: 'r1', category: 'Comida', splits: { a: 10, b: 90 } },
    ]);
    expect(snap).toEqual(congelado);
  });

  it('sin miembros devuelve null en vez de un gasto que nadie debe', () => {
    expect(buildSplitSnapshot(100, 'Comida', [], [])).toBeNull();
  });

  it('las partes salen ordenadas por user_id (estable para diffs y para la DB)', () => {
    const ms = members(['zeta', 50], ['alfa', 50], ['mu', 50]);
    const snap = buildSplitSnapshot(100, null, ms, []);
    expect(snap.shares.map((s) => s.user_id)).toEqual(['alfa', 'mu', 'zeta']);
  });
});

describe('computeBalancesFromSnapshots', () => {
  const suma = (b) => Object.values(b).reduce((s, v) => s + v, 0);

  it('el pagador queda acreditado por lo que no le tocaba', () => {
    const ms = members(['a', 50], ['b', 50]);
    const expenses = [
      { paid_by: 'a', amount: 100, split_snapshot: buildSplitSnapshot(100, null, ms, []) },
    ];
    const bal = computeBalancesFromSnapshots(expenses, [], ['a', 'b']);
    expect(bal.a).toBeCloseTo(50);
    expect(bal.b).toBeCloseTo(-50);
    expect(suma(bal)).toBeCloseTo(0);
  });

  it('la liquidacion deja el espacio en cero', () => {
    const ms = members(['a', 50], ['b', 50]);
    const expenses = [
      { paid_by: 'a', amount: 100, split_snapshot: buildSplitSnapshot(100, null, ms, []) },
    ];
    const bal = computeBalancesFromSnapshots(expenses, [{ from_user: 'b', to_user: 'a', amount: 50 }], ['a', 'b']);
    expect(bal.a).toBeCloseTo(0);
    expect(bal.b).toBeCloseTo(0);
  });

  it('un miembro removido sigue debiendo: su deuda no se evapora', () => {
    // Si el balance se calculara solo sobre los miembros actuales, el debito de
    // "removido" desapareceria y "a" quedaria acreditado por plata que nadie debe.
    const msAlRegistrar = members(['a', 50], ['removido', 50]);
    const expenses = [
      { paid_by: 'a', amount: 100, split_snapshot: buildSplitSnapshot(100, null, msAlRegistrar, []) },
    ];
    const bal = computeBalancesFromSnapshots(expenses, [], ['a']); // 'removido' ya no es miembro
    expect(bal.removido).toBeCloseTo(-50);
    expect(suma(bal)).toBeCloseTo(0);
  });

  it('un gasto sin snapshot se le cobra entero al pagador, no filtra al grupo', () => {
    const bal = computeBalancesFromSnapshots(
      [{ paid_by: 'a', amount: 100, split_snapshot: null }],
      [],
      ['a', 'b']
    );
    expect(bal.a).toBeCloseTo(0);
    expect(bal.b).toBeCloseTo(0);
    expect(suma(bal)).toBeCloseTo(0);
  });

  it('con montos que no dividen exacto los balances siguen sumando cero', () => {
    const ms = members(['a', 50], ['b', 50], ['c', 50]);
    const expenses = [10.01, 0.01, 33.33, 999.99].map((amount, i) => ({
      paid_by: ['a', 'b', 'c'][i % 3],
      amount,
      split_snapshot: buildSplitSnapshot(amount, null, ms, []),
    }));
    const bal = computeBalancesFromSnapshots(expenses, [], ['a', 'b', 'c']);
    expect(suma(bal)).toBeCloseTo(0, 10);
  });

  it('el espacio vacio no explota', () => {
    expect(computeBalancesFromSnapshots([], [], [])).toEqual({});
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
