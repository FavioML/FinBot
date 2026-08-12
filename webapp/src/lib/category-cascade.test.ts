// Guard de COMPORTAMIENTO del cascade de categorías.
//
// LO QUE NO ES: un test que cuente strings en CASCADE_REFS. Contar entradas de la
// declaración pasaría en verde con el cascade entero comentado — la lista y el código
// son dos cosas distintas, y el defecto del 2026-08-12 fue exactamente que la lista
// existía (`NAME_REF_TABLES`) y no describía lo que el esquema tenía.
//
// LO QUE SÍ HACE: le pasa a las cuatro operaciones REALES (las que importa el
// endpoint, no una copia) un cliente Supabase falso que anota cada
// `from().update()/delete()` con sus filtros, y afirma que el conjunto de
// (tabla, columna, operación, scope) tocado es exactamente el declarado. Agregar una
// entrada a CASCADE_REFS sin que el código la recorra → rojo. Sacar una tabla del
// bucle → rojo. Perder el filtro por dueño → rojo.
//
// LA MITAD QUE ESTE ARCHIVO NO PUEDE CONTESTAR: "¿existe en la DB una columna de
// categoría que la declaración no nombra?". Eso necesita el esquema vivo y vive en
// `qa-e2e/qa-categorias-cascade-schema.mjs`. El par es el mismo patrón que
// `merge-and-link-columnas.test.js` + `qa-web-signup-merge.mjs`: el guard hermético
// dice que el árbol es coherente consigo mismo, el harness contra prod dice que el
// árbol describe la DB real. Uno solo de los dos deja el agujero por el que entró esto.

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  cascadeRootDelete,
  cascadeSubDelete,
  relabelRootName,
  relabelSubName,
  exactCI,
} from './category-cascade';
import { CASCADE_REFS, EXEMPT_REFS, SUB_SENTINEL_REVISAR } from './category-refs';

const USER = 'u-1';

interface Op {
  table: string;
  kind: 'update' | 'delete';
  patch: Record<string, unknown> | null;
  eq: [string, unknown][];
  /** `.filter(col, 'imatch', patron)` — el match exacto CI. Ver `exactCI`. */
  imatch: [string, string][];
}

/**
 * Cliente falso: no habla con nadie, solo anota qué le pidieron. `fallaEn` simula el
 * modo de falla real de postgrest-js, que NO lanza: devuelve `{ error }`.
 */
function fakeSvc(fallaEn?: string) {
  const ops: Op[] = [];
  const from = (table: string) => {
    const mk = (kind: Op['kind'], patch: Record<string, unknown> | null) => {
      const op: Op = { table, kind, patch, eq: [], imatch: [] };
      ops.push(op);
      const chain: Record<string, unknown> = {
        eq(col: string, val: unknown) { op.eq.push([col, val]); return chain; },
        filter(col: string, oper: string, val: string) {
          // Si alguien vuelve a `ilike`, este fake no lo registra y las aserciones de
          // scope quedan vacías → rojo. Es a propósito: `ilike` es el operador que
          // reabre el agujero del `*`.
          if (oper !== 'imatch') throw new Error(`operador inesperado: ${oper} (¿volvió ilike?)`);
          op.imatch.push([col, val]);
          return chain;
        },
        // El `await` de las operaciones resuelve por acá.
        then(res: (v: unknown) => void) {
          res({ data: null, error: table === fallaEn ? { message: 'boom' } : null });
        },
      };
      return chain;
    };
    return {
      update: (patch: Record<string, unknown>) => mk('update', patch),
      delete: () => mk('delete', null),
    };
  };
  return { svc: { from } as unknown as SupabaseClient, ops };
}

const conSub = CASCADE_REFS.filter((r) => r.sub);
const refDe = (t: string) => CASCADE_REFS.find((r) => r.table === t)!;

describe('relabelRootName — el defecto del 2026-08-12', () => {
  it('reetiqueta TODA columna de raíz declarada, no solo las tres que cascadeaban', async () => {
    const { svc, ops } = fakeSvc();
    await relabelRootName(svc, USER, 'Alimentación', 'Comida');

    const tocadas = ops.map((o) => `${o.table}.${Object.keys(o.patch!)[0]}`).sort();
    expect(tocadas).toEqual(CASCADE_REFS.map((r) => `${r.table}.${r.cat}`).sort());

    // Las dos que faltaban, nombradas a mano: si alguien las saca de la declaración,
    // este test las reclama igual en vez de adaptarse en silencio a la lista nueva.
    expect(tocadas, 'el detector de fugas quedó fuera').toContain('spending_alerts.category');
    expect(tocadas, 'los gastos compartidos quedaron fuera').toContain('gastos_compartidos.categoria');

    for (const op of ops) {
      expect(op.kind).toBe('update');
      expect(Object.values(op.patch!)).toEqual(['Comida']);
      expect(op.eq, `${op.table}: falta el filtro por dueño`).toContainEqual([refDe(op.table).owner, USER]);
      expect(op.imatch).toEqual([[refDe(op.table).cat, exactCI('Alimentación')]]);
    }
  });

  it('no toca nada si el nombre no cambió', async () => {
    const { svc, ops } = fakeSvc();
    await relabelRootName(svc, USER, 'Comida', 'Comida');
    expect(ops).toEqual([]);
  });

  it('el patrón es un match EXACTO, aunque el nombre lleve comodines', async () => {
    // El agujero medido contra prod el 12-ago-2026: con `ilike`, PostgREST traduce `*`
    // a `%` del lado del servidor, y no hay escape posible desde el cliente. Una
    // categoría llamada `*` —creable, `cleanName` solo valida largo— hacía que el
    // DELETE del cascade barriera TODAS las filas del usuario. `imatch` (regex POSIX)
    // sí respeta el escape.
    const { svc, ops } = fakeSvc();
    await relabelRootName(svc, USER, '100%_a*b', 'Ahorro');
    for (const op of ops) {
      const patron = op.imatch[0][1];
      expect(patron.startsWith('^') && patron.endsWith('$'), 'el patrón tiene que estar anclado').toBe(true);
      expect(patron).toBe('^100%_a\\*b$');
      // Y se comporta como regex exacta contra los valores que importan.
      const re = new RegExp(patron, 'i');
      expect(re.test('100%_a*b')).toBe(true);
      expect(re.test('100%_ab'), 'el * no puede seguir siendo comodín').toBe(false);
      expect(re.test('Otra categoría')).toBe(false);
    }
    // Los metacaracteres de regex que un nombre de 2–30 chars puede llevar.
    expect(exactCI('a.b')).toBe('^a\\.b$');
    expect(exactCI('(x)')).toBe('^\\(x\\)$');
    expect(new RegExp(exactCI('**'), 'i').test('cualquier cosa'), 'un nombre de puros comodines no puede matchear todo').toBe(false);
  });
});

describe('una tabla que falla no se traga el error ni frena al resto', () => {
  it('loguea el `{error}` de postgrest y sigue con las demás tablas', async () => {
    // postgrest-js NO lanza. Sin leer `{error}`, una tabla que falla deja el defecto
    // original —filas con el nombre viejo— y encima con el fix puesto, o sea sin
    // ningún síntoma que lo delate. Clase `error-no-leido`.
    const primera = CASCADE_REFS[0].table;
    const { svc, ops } = fakeSvc(primera);
    const gritos: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { gritos.push(a.join(' ')); };
    try {
      await relabelRootName(svc, USER, 'Alimentación', 'Comida');
    } finally {
      console.error = orig;
    }
    expect(gritos.some((g) => g.includes(primera) && g.includes('boom')), 'el fallo salió en silencio').toBe(true);
    // Y no abortó: parar a la mitad deja la taxonomía partida en dos.
    expect(ops.length).toBe(CASCADE_REFS.length);
  });

  it('no grita cuando todo sale bien', async () => {
    const { svc } = fakeSvc();
    const gritos: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { gritos.push(a.join(' ')); };
    try {
      await relabelRootName(svc, USER, 'Alimentación', 'Comida');
    } finally {
      console.error = orig;
    }
    expect(gritos).toEqual([]);
  });
});

describe('relabelSubName', () => {
  it('solo entra a las tablas con nivel de sub, y filtra por el padre', async () => {
    const { svc, ops } = fakeSvc();
    await relabelSubName(svc, USER, 'Alimentación', 'Almuerzo', 'Menú');

    expect(ops.map((o) => o.table).sort()).toEqual(conSub.map((r) => r.table).sort());
    for (const op of ops) {
      const ref = refDe(op.table);
      // Sin el filtro por padre, esto se llevaría puesto un "Almuerzo" de otra raíz.
      expect(op.imatch).toContainEqual([ref.cat, exactCI('Alimentación')]);
      expect(op.imatch).toContainEqual([ref.sub!, exactCI('Almuerzo')]);
      expect(op.patch![ref.sub!]).toBe('Menú');
      expect(op.eq).toContainEqual([ref.owner, USER]);
    }
  });

  it('no toca nada si la sub no cambió', async () => {
    const { svc, ops } = fakeSvc();
    await relabelSubName(svc, USER, 'Alimentación', 'Almuerzo', 'Almuerzo');
    expect(ops).toEqual([]);
  });
});

describe('cascadeRootDelete', () => {
  it('alcanza a todas las tablas declaradas, cada una con SU política', async () => {
    const { svc, ops } = fakeSvc();
    await cascadeRootDelete(svc, USER, 'Alimentación');

    expect(ops.map((o) => o.table).sort()).toEqual(CASCADE_REFS.map((r) => r.table).sort());

    for (const ref of CASCADE_REFS) {
      const op = ops.find((o) => o.table === ref.table)!;
      expect(op.kind, `${ref.table}: la política declarada es ${ref.onRootDelete}`).toBe(
        ref.onRootDelete === 'delete' ? 'delete' : 'update'
      );
      expect(op.eq, `${ref.table}: falta el filtro por dueño`).toContainEqual([ref.owner, USER]);
      expect(op.imatch).toEqual([[ref.cat, exactCI('Alimentación')]]);
      if (ref.onRootDelete === 'detach') {
        expect(op.patch![ref.cat]).toBeNull();
        // El centinela es lo que enciende "Por revisar", y solo va donde hay sub.
        if (ref.sub) expect(op.patch![ref.sub]).toBe(SUB_SENTINEL_REVISAR);
        else expect(Object.keys(op.patch!)).toEqual([ref.cat]);
      }
    }
  });

  it('el borrado de una raíz nunca borra transacciones', async () => {
    // La barrera del incidente del 01-ago-2026: la plata del usuario se desetiqueta,
    // no se destruye. Un `delete` sobre `transacciones` acá sería pérdida de datos.
    const { svc, ops } = fakeSvc();
    await cascadeRootDelete(svc, USER, 'Alimentación');
    expect(ops.find((o) => o.table === 'transacciones')!.kind).toBe('update');
  });
});

describe('cascadeSubDelete', () => {
  it('alcanza solo a las tablas con sub, con la política de sub de cada una', async () => {
    const { svc, ops } = fakeSvc();
    await cascadeSubDelete(svc, USER, 'Alimentación', 'Almuerzo');

    expect(ops.map((o) => o.table).sort()).toEqual(conSub.map((r) => r.table).sort());
    for (const ref of conSub) {
      const op = ops.find((o) => o.table === ref.table)!;
      expect(op.kind).toBe(ref.onSubDelete === 'delete' ? 'delete' : 'update');
      if (ref.onSubDelete === 'detach') {
        // Suelta la sub y CONSERVA la categoría padre.
        expect(op.patch).toEqual({ [ref.sub!]: null });
      }
      expect(op.eq).toContainEqual([ref.owner, USER]);
      expect(op.imatch).toContainEqual([ref.cat, exactCI('Alimentación')]);
      expect(op.imatch).toContainEqual([ref.sub!, exactCI('Almuerzo')]);
    }
  });
});

describe('la declaración misma', () => {
  it('no repite una referencia entre cascade y exenta', () => {
    const cascade = new Set<string>();
    for (const r of CASCADE_REFS) {
      cascade.add(`${r.table}.${r.cat}`);
      if (r.sub) cascade.add(`${r.table}.${r.sub}`);
    }
    for (const e of EXEMPT_REFS) {
      expect(cascade.has(e.ref), `${e.ref} está declarada en los dos lados`).toBe(false);
    }
    expect(new Set(EXEMPT_REFS.map((e) => e.ref)).size, 'exención duplicada').toBe(EXEMPT_REFS.length);
    expect(new Set(CASCADE_REFS.map((r) => r.table)).size).toBe(CASCADE_REFS.length);
  });

  it('cada entrada dice por qué, con más que una frase de relleno', () => {
    // Una exención sin motivo es un olvido disfrazado de decisión.
    for (const e of EXEMPT_REFS) expect(e.reason.length, `${e.ref}: motivo muy corto`).toBeGreaterThan(40);
    for (const r of CASCADE_REFS) expect(r.why.length, `${r.table}: falta el porqué`).toBeGreaterThan(40);
  });

  it('la política de sub existe si y solo si hay columna de sub', () => {
    for (const r of CASCADE_REFS) {
      expect(['detach', 'delete']).toContain(r.onRootDelete);
      expect(r.sub === null, `${r.table}: sub y onSubDelete no concuerdan`).toBe(r.onSubDelete === null);
    }
  });

  it('nadie vuelve a `ilike` para matchear un nombre de categoría', async () => {
    // `ilike` es irreparable acá: PostgREST traduce `*` a `%` del lado del servidor.
    // Los archivos que filtran por nombre de categoría tienen que usar `exactCI`, y
    // este barrido incluye `usage/route.ts` PORQUE es el que cuenta lo que el usuario
    // ve antes de confirmar el borrado: si los dos no matchean igual, el preview miente.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const aqui = import.meta.dirname;
    const archivos = {
      'category-cascade.ts': join(aqui, 'category-cascade.ts'),
      'api/categories/route.ts': join(aqui, '..', 'app', 'api', 'categories', 'route.ts'),
      'api/categories/usage/route.ts': join(aqui, '..', 'app', 'api', 'categories', 'usage', 'route.ts'),
    };
    for (const [nombre, ruta] of Object.entries(archivos)) {
      const src = readFileSync(ruta, 'utf8');
      // Anti-vacuidad: si el archivo se movió, esto revienta en vez de pasar en verde.
      expect(src.length, `${nombre} vino vacío`).toBeGreaterThan(200);
      // NINGUNO, tampoco sobre `categorias_usuario.nombre`. La primera versión de este
      // guard eximía a esa columna "porque la tabla no se borra en cascada", y estaba
      // mal: el E2E lo agarró en el acto. El POST busca la fila existente con ese
      // filtro, así que crear una categoría llamada `QA *` matcheaba `QA Nueva` y
      // REACTIVABA + RENOMBRABA una categoría ajena, devolviendo 200 en vez de 201.
      // El agujero no era del cascade, era del operador.
      const usos = src.split('\n')
        .map((l, i) => [i + 1, l] as const)
        .filter(([, l]) => /\.ilike\s*\(/.test(l) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
      expect(usos.map(([n, l]) => `${nombre}:${n} ${l.trim()}`), 'volvió `ilike` sobre un nombre de categoría').toEqual([]);
    }
  });

  it('el endpoint no vuelve a tener su propia lista de tablas', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(import.meta.dirname, '..', 'app', 'api', 'categories', 'route.ts'),
      'utf8'
    );
    // Anti-vacuidad: si el archivo se mueve, esto revienta en vez de pasar.
    expect(src).toContain('@/lib/category-cascade');
    expect(src, 'volvió la lista hardcodeada').not.toMatch(/NAME_REF_TABLES/);
    for (const ref of CASCADE_REFS) {
      expect(src, `hay un array literal con '${ref.table}' en route.ts`).not.toMatch(
        new RegExp(`\\[[^\\]\\n]*['"]${ref.table}['"]`)
      );
    }
  });
});
