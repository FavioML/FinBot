import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as ts from '../../webapp/src/lib/spaces-split.ts';

const require = createRequire(import.meta.url);
const cjs = require('../../services/spaces-split');

/**
 * El backend es CommonJS y la webapp TS/ESM, asi que la division de gastos vive
 * en dos archivos: `webapp/src/lib/spaces-split.ts` (fuente de verdad) y su
 * espejo `services/spaces-split.js`.
 *
 * ESTE archivo es lo unico que impide que se separen. Antes del snapshot habia
 * tres motores de division con numeros distintos para el mismo espacio, y no se
 * notaba porque el usuario de prueba era 50/50 con dos miembros: el unico caso
 * donde los tres coinciden. La divergencia debe ser CI en rojo, no un bug de
 * dinero que aparece el dia que alguien mueve el split por defecto.
 *
 * Si un caso falla, arregla el espejo. No relajes la comparacion.
 */

// PRNG con semilla fija: cientos de casos, mismos casos en cada corrida.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const EXPORTS_COMPARTIDOS = [
  'resolveSplitPlan',
  'splitFractions',
  'resolveSplit',
  'effectiveSplitPercents',
  'effectiveSplitPercentsFor',
  'joinSplitWeight',
  'toCents',
  'allocateShares',
  'buildSplitSnapshot',
  'shareCents',
  'computeBalancesFromSnapshots',
  'simplifyDebts',
  'sanitizeSplitRules',
];

describe('paridad TS <-> CJS · superficie', () => {
  it('el espejo exporta todo lo que exporta la fuente de verdad', () => {
    for (const name of EXPORTS_COMPARTIDOS) {
      expect(typeof ts[name], `TS.${name}`).toBe('function');
      expect(typeof cjs[name], `CJS.${name}`).toBe('function');
    }
  });
});

describe('paridad TS <-> CJS · casos nombrados', () => {
  const casos = [
    {
      nombre: 'split por defecto 50/50',
      category: 'Comida',
      members: [{ user_id: 'a', split_percentage: 50 }, { user_id: 'b', split_percentage: 50 }],
      rules: [],
      amount: 100,
    },
    {
      nombre: 'porcentajes desiguales con 3 miembros',
      category: null,
      members: [
        { user_id: 'a', split_percentage: 50 },
        { user_id: 'b', split_percentage: 30 },
        { user_id: 'c', split_percentage: 20 },
      ],
      rules: [],
      amount: 100.03,
    },
    {
      nombre: 'regla Pro por categoria manda sobre el default',
      category: 'Alimentación',
      members: [
        { user_id: 'a', split_percentage: 50 },
        { user_id: 'b', split_percentage: 30 },
        { user_id: 'c', split_percentage: 20 },
      ],
      rules: [{ id: 'r1', category: 'Alimentación', splits: { a: 70, b: 20, c: 10 } }],
      amount: 100,
    },
    {
      nombre: 'miembro fuera de la regla recibe 0',
      category: 'Comida',
      members: [
        { user_id: 'a', split_percentage: 50 },
        { user_id: 'b', split_percentage: 50 },
        { user_id: 'c', split_percentage: 50 },
      ],
      rules: [{ id: 'r1', category: 'Comida', splits: { a: 50, b: 50 } }],
      amount: 33.33,
    },
    {
      nombre: 'B1: peso rancio de un miembro removido',
      category: 'Comida',
      members: [{ user_id: 'a', split_percentage: 50 }],
      rules: [{ id: 'r1', category: 'Comida', splits: { a: 50, removido: 50 } }],
      amount: 100,
    },
    {
      nombre: 'pesos corruptos (Infinity / negativos)',
      category: 'Comida',
      members: [{ user_id: 'a', split_percentage: 50 }, { user_id: 'b', split_percentage: -3 }],
      rules: [{ id: 'r1', category: 'Comida', splits: { a: Infinity, b: 50 } }],
      amount: 0.01,
    },
    {
      nombre: 'sin porcentajes utiles cae a partes iguales',
      category: null,
      members: [
        { user_id: 'a', split_percentage: 0 },
        { user_id: 'b', split_percentage: null },
        { user_id: 'c', split_percentage: 0 },
      ],
      rules: [],
      amount: 100,
    },
    {
      nombre: 'seis miembros y un centavo',
      category: null,
      members: 'abcdef'.split('').map((id) => ({ user_id: id, split_percentage: 50 })),
      rules: [],
      amount: 0.01,
    },
    {
      nombre: 'monto maximo permitido por el guard de la API',
      category: null,
      members: 'abcdef'.split('').map((id) => ({ user_id: id, split_percentage: 50 })),
      rules: [],
      amount: 999999.99,
    },
    {
      nombre: 'sin miembros',
      category: 'Comida',
      members: [],
      rules: [{ id: 'r1', category: 'Comida', splits: { a: 100 } }],
      amount: 50,
    },
  ];

  for (const c of casos) {
    it(c.nombre, () => {
      expect(cjs.resolveSplitPlan(c.category, c.members, c.rules))
        .toEqual(ts.resolveSplitPlan(c.category, c.members, c.rules));
      expect(cjs.splitFractions(c.category, c.members, c.rules))
        .toEqual(ts.splitFractions(c.category, c.members, c.rules));
      expect(cjs.buildSplitSnapshot(c.amount, c.category, c.members, c.rules))
        .toEqual(ts.buildSplitSnapshot(c.amount, c.category, c.members, c.rules));
      expect(cjs.effectiveSplitPercents(c.members)).toEqual(ts.effectiveSplitPercents(c.members));
      // El % por categoria es lo que anuncia el aviso de reglas Pro: si los dos
      // runtimes no coinciden, el mensaje promete un numero que el balance no cobra.
      expect(cjs.effectiveSplitPercentsFor(c.category, c.members, c.rules))
        .toEqual(ts.effectiveSplitPercentsFor(c.category, c.members, c.rules));
      // El peso de entrada tiene que ser el mismo por los dos caminos de join, o el
      // mismo espacio divide distinto segun se haya entrado por WhatsApp o por la web.
      expect(cjs.joinSplitWeight(c.members)).toEqual(ts.joinSplitWeight(c.members));
      for (const m of c.members) {
        expect(cjs.resolveSplit(c.category, m.user_id, c.members, c.rules))
          .toEqual(ts.resolveSplit(c.category, m.user_id, c.members, c.rules));
      }
    });
  }
});

describe('paridad TS <-> CJS · aleatorio con semilla', () => {
  const rand = lcg(20260721);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const pesosRaros = [0, null, undefined, -5, Infinity, NaN, 0.5, 33.33, 50, 70, 100, 1000];

  function escenario(i) {
    const n = 1 + Math.floor(rand() * 6);
    const members = [];
    for (let k = 0; k < n; k++) {
      members.push({ user_id: `u${k}`, split_percentage: pick(pesosRaros) });
    }
    const category = pick(['Comida', 'Transporte', 'Alimentación', null, 'Otros']);
    const rules = [];
    if (rand() < 0.6) {
      const splits = {};
      for (const m of members) if (rand() < 0.75) splits[m.user_id] = pick(pesosRaros);
      if (rand() < 0.3) splits.fantasma = pick(pesosRaros);
      rules.push({ id: `r${i}`, category: pick(['Comida', 'Alimentación', 'Transporte']), splits });
    }
    const amount = Math.round(rand() * 500000 * 100) / 100;
    return { members, category, rules, amount };
  }

  it('300 escenarios dan exactamente el mismo snapshot en ambos runtimes', () => {
    for (let i = 0; i < 300; i++) {
      const { members, category, rules, amount } = escenario(i);
      const a = ts.buildSplitSnapshot(amount, category, members, rules);
      const b = cjs.buildSplitSnapshot(amount, category, members, rules);
      expect(b, `escenario ${i}`).toEqual(a);

      expect(cjs.effectiveSplitPercentsFor(category, members, rules), `% por categoria en escenario ${i}`)
        .toEqual(ts.effectiveSplitPercentsFor(category, members, rules));

      // El invariante, verificado sobre el mismo lote: las partes suman el total.
      if (a) {
        const total = a.shares.reduce((s, x) => s + x.cents, 0);
        expect(total, `conservacion en escenario ${i}`).toBe(ts.toCents(amount));
      }
    }
  });

  it('300 hojas de balance dan las mismas transferencias', () => {
    const r = lcg(987654321);
    for (let i = 0; i < 300; i++) {
      const n = 2 + Math.floor(r() * 5);
      const balances = {};
      let acc = 0;
      for (let k = 0; k < n - 1; k++) {
        const v = Math.round((r() * 400 - 200) * 100) / 100;
        balances[`u${k}`] = v;
        acc += v;
      }
      balances[`u${n - 1}`] = Math.round(-acc * 100) / 100;
      expect(cjs.simplifyDebts(balances), `escenario ${i}`).toEqual(ts.simplifyDebts(balances));
    }
  });

  it('300 espacios dan los mismos balances desde snapshots', () => {
    const r = lcg(55555);
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(r() * 5);
      const members = [];
      for (let k = 0; k < n; k++) members.push({ user_id: `u${k}`, split_percentage: pick(pesosRaros) });
      const ids = members.map((m) => m.user_id);

      const expenses = [];
      for (let e = 0; e < Math.floor(r() * 6); e++) {
        const amount = Math.round(r() * 100000) / 100;
        expenses.push({
          paid_by: ids[Math.floor(r() * ids.length)],
          amount,
          split_snapshot: ts.buildSplitSnapshot(amount, 'Comida', members, []),
        });
      }
      const settlements = [];
      for (let s = 0; s < Math.floor(r() * 3) && ids.length > 1; s++) {
        settlements.push({
          from_user: ids[0],
          to_user: ids[ids.length - 1],
          amount: Math.round(r() * 10000) / 100,
        });
      }

      const a = ts.computeBalancesFromSnapshots(expenses, settlements, ids);
      const b = cjs.computeBalancesFromSnapshots(expenses, settlements, ids);
      expect(b, `escenario ${i}`).toEqual(a);

      // Los balances de un espacio suman cero. Si no, hay dinero fantasma.
      const suma = Object.values(a).reduce((s, v) => s + v, 0);
      expect(Math.abs(suma), `suma cero en escenario ${i}`).toBeLessThan(0.005);
    }
  });

  it('300 espacios dan el mismo peso de entrada y los mismos % efectivos', () => {
    const r = lcg(31415926);
    for (let i = 0; i < 300; i++) {
      const n = Math.floor(r() * 6);
      const members = [];
      for (let k = 0; k < n; k++) members.push({ user_id: `u${k}`, split_percentage: pick(pesosRaros) });

      expect(cjs.joinSplitWeight(members), `peso de entrada en escenario ${i}`)
        .toEqual(ts.joinSplitWeight(members));
      expect(cjs.effectiveSplitPercents(members), `% efectivos en escenario ${i}`)
        .toEqual(ts.effectiveSplitPercents(members));
    }
  });

  it('sanitizeSplitRules se comporta igual en ambos', () => {
    const r = lcg(424242);
    const memberIds = new Set(['a', 'b', 'c']);
    for (let i = 0; i < 100; i++) {
      const splits = {};
      for (const uid of ['a', 'b', 'c', 'fantasma']) {
        if (r() < 0.7) splits[uid] = pick(pesosRaros);
      }
      const rules = [{ id: r() < 0.5 ? `r${i}` : '', category: r() < 0.9 ? 'Comida' : '', splits }];
      expect(cjs.sanitizeSplitRules(rules, memberIds)).toEqual(ts.sanitizeSplitRules(rules, memberIds));
    }
  });
});
