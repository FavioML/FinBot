import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { joinSplitWeight, splitFractions, effectiveSplitPercents } = require('../../services/spaces-split');

/**
 * Que le pasa al reparto de los que YA estaban cuando entra alguien.
 *
 * Los dos caminos de join lo rompian de formas distintas: el backend de WhatsApp
 * reescribia a TODOS a 100/n (un 70/30 acordado moria porque llego un tercero) y
 * la webapp metia al nuevo con un 50 fijo sin mirar al resto (un 70/30 quedaba en
 * 70/30/50, o sea 46.7/20/33.3 al normalizar). Como los gastos congelan su
 * division en `split_snapshot`, nada de eso reescribia el pasado, pero si cambiaba
 * como se dividen los gastos FUTUROS sin que nadie lo pidiera.
 *
 * La regla ahora es una sola: el que entra toma el peso PROMEDIO de los vigentes y
 * a nadie mas se le toca el peso.
 */

/** % efectivo de cada uno con el split por defecto, que es lo que se cobra. */
const pct = (members) => effectiveSplitPercents(members);

/** Simula un join: agrega al nuevo con el peso que le toca, sin tocar a los demas. */
function unirse(members, nuevoId) {
  return members.concat([{ user_id: nuevoId, split_percentage: joinSplitWeight(members) }]);
}

describe('joinSplitWeight · espacio sin personalizar', () => {
  it('50/50 + uno = tercios exactos, sin haber reescrito a nadie', () => {
    const antes = [
      { user_id: 'a', split_percentage: 50 },
      { user_id: 'b', split_percentage: 50 },
    ];
    const despues = unirse(antes, 'c');

    // Nadie fue tocado: a y b siguen con el peso que tenian.
    expect(despues.slice(0, 2)).toEqual(antes);
    expect(despues[2].split_percentage).toBe(50);

    const p = pct(despues);
    expect(p).toEqual({ a: 33.3, b: 33.3, c: 33.3 });
  });

  it('espacio de un solo miembro: al entrar el segundo quedan 50/50', () => {
    const despues = unirse([{ user_id: 'a', split_percentage: 50 }], 'b');
    expect(pct(despues)).toEqual({ a: 50, b: 50 });
  });

  it('un espacio vacio le da el peso por defecto al primero que entra', () => {
    expect(joinSplitWeight([])).toBe(50);
  });

  it('cuatro en partes iguales + uno siguen en partes iguales', () => {
    const antes = 'abcd'.split('').map((id) => ({ user_id: id, split_percentage: 50 }));
    const p = pct(unirse(antes, 'e'));
    for (const id of 'abcde') expect(p[id]).toBe(20);
  });
});

describe('joinSplitWeight · espacio con reparto acordado', () => {
  const setenta30 = [
    { user_id: 'a', split_percentage: 70 },
    { user_id: 'b', split_percentage: 30 },
  ];

  it('el nuevo asume un tercio y a los dos originales no se les toca el peso', () => {
    const despues = unirse(setenta30, 'c');
    expect(despues.slice(0, 2)).toEqual(setenta30);
    expect(despues[2].split_percentage).toBe(50);
    expect(pct(despues)).toEqual({ a: 46.7, b: 20, c: 33.3 });
  });

  it('la proporcion pactada entre los originales sobrevive al join', () => {
    const f = splitFractions(null, unirse(setenta30, 'c'), []);
    // Antes 70:30 = 2.333x. Despues tiene que seguir siendo 2.333x.
    expect(f.a / f.b).toBeCloseTo(70 / 30, 10);
  });

  it('NO se re-reparte a partes iguales (la regresion que cerramos)', () => {
    const p = pct(unirse(setenta30, 'c'));
    expect(p.a).not.toBe(33.3);
    expect(p.a).toBeGreaterThan(p.c);
    expect(p.c).toBeGreaterThan(p.b);
  });

  it('dos joins seguidos siguen sin reescribir el acuerdo original', () => {
    const f = splitFractions(null, unirse(unirse(setenta30, 'c'), 'd'), []);
    expect(f.a / f.b).toBeCloseTo(70 / 30, 10);
    // Los dos que entraron toman el mismo peso promedio, asi que pagan igual.
    expect(f.c).toBeCloseTo(f.d, 10);
  });
});

describe('joinSplitWeight · bordes', () => {
  it('un miembro excluido (peso 0) no arrastra el promedio hacia abajo', () => {
    const antes = [
      { user_id: 'a', split_percentage: 60 },
      { user_id: 'b', split_percentage: 0 },
    ];
    // Promedio de los que SI pagan: 60, no 30.
    expect(joinSplitWeight(antes)).toBe(60);
    expect(pct(unirse(antes, 'c'))).toEqual({ a: 50, b: 0, c: 50 });
  });

  it('espacio con todos en 0 sigue cayendo a partes iguales', () => {
    const antes = [
      { user_id: 'a', split_percentage: 0 },
      { user_id: 'b', split_percentage: null },
    ];
    // Entrar con peso dejaria al recien llegado pagandolo todo.
    expect(joinSplitWeight(antes)).toBe(0);
    expect(pct(unirse(antes, 'c'))).toEqual({ a: 33.3, b: 33.3, c: 33.3 });
  });

  it('pesos corruptos no producen un peso de entrada corrupto', () => {
    for (const raro of [Infinity, NaN, -20, undefined]) {
      const w = joinSplitWeight([
        { user_id: 'a', split_percentage: raro },
        { user_id: 'b', split_percentage: 40 },
      ]);
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBe(40);
    }
  });

  it('el peso de entrada siempre cabe en la columna NUMERIC(5,2) y en el CHECK 0-100', () => {
    const casos = [
      [{ user_id: 'a', split_percentage: 100 }, { user_id: 'b', split_percentage: 100 }],
      [{ user_id: 'a', split_percentage: 100 }, { user_id: 'b', split_percentage: 1 }],
      [{ user_id: 'a', split_percentage: 33.33 }, { user_id: 'b', split_percentage: 33.33 }],
      [{ user_id: 'a', split_percentage: 0.01 }],
    ];
    for (const members of casos) {
      const w = joinSplitWeight(members);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(100);
      expect(Math.round(w * 100)).toBe(w * 100);
    }
  });
});

describe('effectiveSplitPercents', () => {
  it('reporta lo que se paga de verdad, no el peso crudo de la columna', () => {
    const members = [
      { user_id: 'a', split_percentage: 70 },
      { user_id: 'b', split_percentage: 30 },
      { user_id: 'c', split_percentage: 50 },
    ];
    // La pantalla mostraba 70/30/50, que suma 150 y no es lo que se cobra.
    expect(pct(members)).toEqual({ a: 46.7, b: 20, c: 33.3 });
  });

  it('los porcentajes efectivos suman ~100 en cualquier espacio con miembros', () => {
    const casos = [
      [{ user_id: 'a', split_percentage: 50 }],
      [{ user_id: 'a', split_percentage: 70 }, { user_id: 'b', split_percentage: 30 }],
      'abcdef'.split('').map((id) => ({ user_id: id, split_percentage: 50 })),
      [{ user_id: 'a', split_percentage: 0 }, { user_id: 'b', split_percentage: 0 }],
    ];
    for (const members of casos) {
      const suma = Object.values(pct(members)).reduce((s, v) => s + v, 0);
      expect(Math.abs(suma - 100)).toBeLessThanOrEqual(0.5);
    }
  });
});
