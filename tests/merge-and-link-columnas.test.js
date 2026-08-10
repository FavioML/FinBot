// Ninguna columna de `usuarios` se cae del merge de identidad sin que alguien lo decida.
//
// POR QUÉ EXISTE. `merge_and_link` fusiona las dos filas de un usuario (la de WhatsApp y la de
// la web) enumerando las columnas A MANO, y después BORRA al loser. O sea que una columna que
// la lista no nombra no se "queda como estaba": se destruye. Ya pasó dos veces con el mismo
// mecanismo y ninguna la atrapó un test:
//
//   · B11 (auditoría 03-ago, migración 059): `trial_*`, creadas por la 052. El merge dejaba
//     `plan='premium'` con `trial_estado=NULL` → Pro INDEFINIDO, invisible para los dos crons
//     de vencimiento. Primera víctima real, reparada a mano.
//   · B13 (auditoría 10-ago, migración 066): `bsuid`, creada por la 065 seis días antes. El
//     BSUID vive en la fila de WhatsApp, que es siempre el loser, así que el camino feliz de
//     activación borraba el único mapeo que reconoce a quien activa un username.
//
// Las dos veces la causa fue la misma, y no es olvidarse: es que **nada conectaba** "agregué
// una columna a `usuarios`" con "hay una función que las enumera". Este test es esa conexión.
// No juzga qué DEBERÍA fusionarse —eso es criterio de producto— sino que la decisión se haya
// TOMADO y esté escrita. Una columna nueva sin clasificar rompe el build.
//
// La lista de columnas se DERIVA (base congelada ∪ los `add column` de migrations/), no es un
// snapshot a mano: un snapshot que hay que acordarse de actualizar falla exactamente cuando
// falla el problema que viene a resolver. Ver `qa-e2e/lib/usuarios-columnas.mjs`, que además
// explica qué mide el hermano de este guard contra el esquema VIVO.

import { describe, it, expect } from 'vitest';
import {
  BASE,
  NO_SE_FUSIONAN,
  columnasQueAgrega,
  columnasSegunElArbol,
  mergeVigente,
} from '../qa-e2e/lib/usuarios-columnas.mjs';

describe('merge_and_link: la lista de columnas no se queda atrás', () => {
  const { archivo, cols: nombradas, bloques } = mergeVigente();
  const todas = columnasSegunElArbol();

  it('el parser encontró la función y sus dos UPDATE (anti-vacuidad)', () => {
    // Sin esto, cualquier cambio de forma en el SQL (renombrar el parámetro, partir el UPDATE)
    // dejaría `nombradas` vacío y el test pasaría a quejarse de las 40 columnas de golpe — o
    // peor, si alguien "arreglara" eso ampliando las exclusiones, dejaría de significar nada.
    expect(archivo, 'ninguna migración define merge_and_link').toBeTruthy();
    expect(bloques, 'no se encontró el UPDATE del survivor en ' + archivo).toBe(2);
    expect(nombradas.size, 'el UPDATE del survivor no asignó casi nada; el parser se rompió')
      .toBeGreaterThan(20);
    expect(todas.size, 'la lista de columnas quedó más chica que la base congelada')
      .toBeGreaterThanOrEqual(BASE.length);
  });

  it('toda columna de usuarios está fusionada o declarada como no-fusionada', () => {
    const sinClasificar = [...todas].filter((c) => !nombradas.has(c) && !(c in NO_SE_FUSIONAN)).sort();

    expect(
      sinClasificar,
      'Estas columnas de `usuarios` NO las nombra merge_and_link y NO están declaradas como ' +
      'excluidas:\n' + sinClasificar.map((c) => '  - ' + c).join('\n') +
      '\n\nEl merge BORRA la fila del loser, así que una columna que la función no nombra se ' +
      'PIERDE (es lo que pasó con trial_* en B11 y con bsuid en B13). Decidí cuál de las dos ' +
      'cosas es:\n' +
      '  · se fusiona → nueva migración con el CREATE OR REPLACE completo (la vigente es ' +
      archivo + '; no la edites), agregando su línea al UPDATE del survivor y pensando de qué ' +
      'lado viene el valor bueno;\n' +
      '  · no se fusiona → sumala a NO_SE_FUSIONAN en qa-e2e/lib/usuarios-columnas.mjs, CON el ' +
      'motivo. El motivo es el punto: es lo que la próxima auditoría va a leer para decidir si ' +
      'sigue siendo cierto.',
    ).toEqual([]);
  });

  it('ninguna columna está en los dos lados (una exclusión obsoleta miente)', () => {
    const ambos = Object.keys(NO_SE_FUSIONAN).filter((c) => nombradas.has(c)).sort();
    expect(
      ambos,
      'Estas columnas están declaradas como NO fusionadas pero el merge SÍ las nombra:\n' +
      ambos.map((c) => '  - ' + c).join('\n') +
      '\n\nSacalas de NO_SE_FUSIONAN. Una exclusión que dejó de ser cierta es peor que ninguna: ' +
      'el motivo escrito al lado invita a la próxima sesión a razonar sobre algo que ya no pasa.',
    ).toEqual([]);
  });

  it('el parser de migraciones ve la forma multi-columna, no solo la primera', () => {
    // `ALTER TABLE t ADD COLUMN a ..., ADD COLUMN b ...` es una forma que este árbol ya usa
    // (migraciones 006, 018, 050, sobre otras tablas). La primera versión de este guard leía
    // solo la primera columna de esa sentencia, así que el día que `usuarios` la usara, las
    // demás quedaban invisibles — y una columna que el guard no ve es una que nadie clasifica.
    // Se ejercita el PARSER REAL con SQL sintético, no una copia del regex: una copia solo
    // detecta que editaste una de las dos, que es la lección de los tests de railway-watchpatterns.
    expect(columnasQueAgrega(
      'ALTER TABLE usuarios\n  ADD COLUMN IF NOT EXISTS uno text,\n  ADD COLUMN IF NOT EXISTS dos boolean NOT NULL DEFAULT false;',
    )).toEqual(['uno', 'dos']);

    // Y no se lleva por delante lo que NO es de usuarios: la sentencia se ancla a la tabla.
    expect(columnasQueAgrega('ALTER TABLE deudas ADD COLUMN IF NOT EXISTS otra text;')).toEqual([]);
    expect(columnasQueAgrega('alter table public.usuarios add column if not exists tres text;')).toEqual(['tres']);
  });

  it('las exclusiones, la base y el UPDATE nombran columnas que existen', () => {
    // Una exclusión sobre una columna borrada, o una base con un typo, es un guard que vigila
    // el vacío. Se mira contra el conjunto derivado, que es la única lista real que hay acá.
    const fantasmas = [...Object.keys(NO_SE_FUSIONAN), ...BASE].filter((c) => !todas.has(c)).sort();
    expect(fantasmas, 'columnas declaradas que no existen en el esquema derivado').toEqual([]);

    const inventadas = [...nombradas].filter((c) => !todas.has(c)).sort();
    expect(
      inventadas,
      'El UPDATE del survivor asigna columnas que no existen en `usuarios`:\n' +
      inventadas.map((c) => '  - ' + c).join('\n') +
      '\n\nO es un typo en la migración (y el merge falla en runtime), o la columna se creó ' +
      'fuera de migrations/, que la regla de .claude/rules/database.md no permite.',
    ).toEqual([]);
  });
});
