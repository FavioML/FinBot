import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'path';

/**
 * Ninguna lectura de `cron/checks.js` puede tirar el `{ error }`.
 *
 * supabase-js **no lanza**: devuelve `{ data: null, error }`. Un `const { data } = await
 * supabase...` no es una abreviatura, es una decisión — la de tratar una caída de la base
 * exactamente igual que "no hay a quién avisar". Y eso no deja excepción, ni log, ni fila en
 * `errores`: el cron corre, no falla, y se apaga mudo.
 *
 * Este guard es de FORMA. Que la forma sirva para algo lo prueba `lecturas-con-error.test.js`,
 * corriendo los crons con la tabla caída y afirmando a quién se notifica. Los dos hacen falta
 * y ninguno reemplaza al otro: el funcional cubre los casos que se ejercitan hoy, este cubre
 * la lectura que alguien agregue mañana.
 *
 * **Por qué mide la FORMA del statement y no busca una cadena.** Un guard que preguntara
 * "¿aparece `error:` en el archivo?" se satisface con una sola lectura arreglada. Uno que
 * mirara sólo la línea del `await` se evade con un salto de línea, que es justamente cómo
 * están escritas las queries largas de este archivo. Acá se extrae cada expresión
 * `await supabase.` con su lado izquierdo completo y se exige que ese lado **nombre el
 * error**, sea cual sea la sintaxis. Las evasiones que se probaron están fijadas abajo en
 * `EVASIONES`, ejecutadas contra el mismo parser que corre sobre el archivo real — no
 * descritas en un comentario.
 */

/**
 * **Lo que este guard NO puede decir.** Mira UN archivo, así que una lectura muda que viva en
 * un servicio que el cron llama queda fuera por construcción. No es hipotético: al cerrarse
 * este trabajo quedaron dos casos identificados y anotados en el backlog de confiabilidad —
 * `services/survey-triggers.js` (12 lecturas, cuatro de ellas fallan ABIERTO, y su cron lo
 * re-exporta este mismo archivo) y `services/debts.js`, cuya población de deudas se lava a
 * través de un `return data || []`. Extender el guard a los servicios que alimentan crons es
 * el trabajo siguiente; declararlo acá evita que el verde de este archivo se lea como
 * "los crons ya están cubiertos".
 */
const RUTA = path.join(process.cwd(), 'cron', 'checks.js');
const FUENTE = readFileSync(RUTA, 'utf-8');

/**
 * Reemplaza comentarios por espacios del MISMO largo. Preserva los offsets, o sea que los
 * números de línea del reporte siguen siendo los del archivo real — y de paso un
 * `await supabase.` que viva dentro de un comentario deja de contar como código.
 */
function sinComentarios(src) {
  const blanco = (m) => m.replace(/[^\n]/g, ' ');
  return src.replace(/\/\*[\s\S]*?\*\//g, blanco).replace(/\/\/[^\n]*/g, blanco);
}

/**
 * Extrae cada uso de `supabase.from(...)` / `supabase.rpc(...)` con su lado izquierdo.
 *
 * Devuelve `{ lhs, linea }`. `lhs` es `null` cuando el statement no asigna nada: una
 * escritura fire-and-forget.
 *
 * **Dos cosas que una revisión adversarial rompió y que la forma de acá existe para cerrar:**
 *
 *   · **`Promise.all` era invisible**, y no en teoría: `checkRecordatorioOnboarding` ya lo usa
 *     para sus dos lecturas. El regex viejo exigía `await supabase`, y ahí el `await` está
 *     sobre el `Promise.all`, no sobre la query. O sea que el guard arrancaba con **dos
 *     puntos ciegos dentro de su propio archivo**, y esas dos lecturas leían su error por
 *     suerte, no por el invariante. Por eso ahora ancla en `supabase.from(` y no en el `await`.
 *   · **El backtrack cruzaba statements.** Retrocedía 400 caracteres hasta el último
 *     `const|let|var`, así que `yaAviso = await supabase...` heredaba el LHS del destructuring
 *     de la línea de arriba y pasaba como si leyera el error. En un archivo donde casi toda
 *     línea previa es un `const { data, error } =`, eso pasaba desde casi cualquier lugar. Por
 *     eso ahora el statement se corta en el `;` anterior, que es lo que ningún destructuring
 *     de este archivo contiene.
 */
function lecturas(srcConComentarios) {
  const src = sinComentarios(srcConComentarios);
  const out = [];
  const re = /\bsupabase\s*\.\s*(?:from|rpc)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const linea = src.slice(0, m.index).split('\n').length;
    // El statement: desde el `;` anterior (o el inicio de la ventana) hasta la query.
    const ventana = src.slice(Math.max(0, m.index - 600), m.index);
    const izq = ventana.slice(ventana.lastIndexOf(';') + 1);
    // El primer `=` de ASIGNACIÓN: ni flecha (`=>`), ni comparación (`==`, `!=`, `>=`, `<=`).
    const asign = /(^|[^=!<>])=(?!=|>)/.exec(izq);
    if (!asign) { out.push({ lhs: null, linea }); continue; }
    out.push({ lhs: izq.slice(0, asign.index + asign[0].length - 1).trim(), linea });
  }
  return out;
}

/**
 * ¿Este statement se queda con el error?
 *
 * Exige `error` como CLAVE del destructuring (`error:`, o `error` suelto seguido de `}` o
 * `,`), no como subcadena. Sin eso, una variable llamada `errorPrevio` alcanzaría para pasar.
 */
function leeElError(lhs) {
  if (!lhs || !lhs.includes('{')) return false;   // sin destructuring no hay error que leer
  return /\berror\s*(:|[,}])/.test(lhs);
}

/** Statements con asignación: son lecturas (o escrituras cuyo resultado se mira). */
const CON_ASIGNACION = lecturas(FUENTE).filter((l) => l.lhs !== null);
/** Sin asignación: `await supabase.from(...).insert(...)` y demás. */
const SIN_ASIGNACION = lecturas(FUENTE).filter((l) => l.lhs === null);

describe('el parser ve lo que dice ver', () => {
  /**
   * Primero, que el parser encuentre algo. Un guard que filtra sobre una lista vacía sale
   * verde sin mirar nada, y es el modo de falla más común de este tipo de archivo: alcanza
   * con que alguien mueva las queries a un helper para que este archivo deje de significar.
   */
  it('encuentra las lecturas del cron', () => {
    // El piso va cerca del conteo real (40 al escribir esto) y no en un número cómodo: con
    // un piso de 30 se podían mover 10 lecturas a un helper antes de que este assert se
    // enterara, y mover queries a un servicio es exactamente cómo está escrito medio backend.
    expect(CON_ASIGNACION.length).toBeGreaterThanOrEqual(38);
  });

  /**
   * Y que sepa distinguir. Cada fila es una forma que un guard más flojo daría por buena.
   */
  const EVASIONES = [
    ['const { data: usuarios } = await supabase.from("usuarios").select("*")', false, 'el bug original'],
    ['const { count } = await supabase.from("t").select("id", { count: "exact" })', false, 'la variante de conteo'],
    ['const r = await supabase.from("t").select("*")', false, 'sin destructuring: el error queda en r y nadie lo mira'],
    ['const { data: u, error: e } = await supabase.from("t").select("*")', true, 'la forma correcta'],
    ['const { data, error } = await supabase.from("t").select("*")', true, 'error suelto, sin renombrar'],
    ['const { data: errorPrevio } = await supabase.from("t").select("*")', false, 'una variable que CONTIENE "error" no es leer el error'],
    ['await supabase.from("t").insert({ a: 1 })', false, 'fire-and-forget: no hay LHS'],
    ['const [{ data: a, error: e }] = await Promise.all([supabase.from("t").select("*")])', true, 'Promise.all: el await esta sobre el all, no sobre la query'],
    ['const [{ data: a }] = await Promise.all([supabase.from("t").select("*")])', false, 'y dentro de un Promise.all tambien se exige el error'],
    // Este fixture NO discriminaba y estuvo a punto de quedarse: con `/* error */` en el
    // LHS, la regex estricta lo rechaza igual porque despues de `error` viene ` *`, no `:`
    // ni `,`. O sea que pasaba por OTRA condicion, y la mutacion "dejar de blanquear
    // comentarios" sobrevivia en verde. El de abajo es el que separa las hipotesis: lleva
    // `error }` adentro del comentario, que SI matchearia la regex sin el blanqueo.
    ['/* devuelve { data, error } */ const { data } = await supabase.from("t").select("*")', false, 'un comentario que menciona `error }` no es leer el error'],
  ];

  it.each(EVASIONES)('%s → %s (%s)', (codigo, esperado) => {
    const encontrado = lecturas(codigo);
    expect(encontrado.length, 'el parser no vio este statement').toBe(1);
    expect(leeElError(encontrado[0].lhs)).toBe(esperado);
  });

  /**
   * El LHS puede venir en la línea anterior al `await` — es la forma que usan las queries
   * largas del archivo. Un parser que mirara sólo la línea del `await` las daría por buenas
   * a todas, que es la evasión más barata que hay.
   */
  /**
   * El otro efecto de blanquear comentarios, y hace falta su propio caso: un
   * `await supabase.` COMENTADO no es código. Sin el blanqueo, el ejemplo de un docblock
   * entra a la lista de lecturas y el guard reporta una línea que nadie ejecuta — que es la
   * dirección de error que enseña a ignorarlo.
   */
  it('un await comentado no cuenta como lectura', () => {
    expect(lecturas('// const { data } = await supabase.from("t").select("*")')).toEqual([]);
    expect(lecturas('/* const { data } = await supabase.from("t") */')).toEqual([]);
  });

  /**
   * **La evasión que rompió el parser anterior.** Retrocedía hasta el último `const` de los
   * 400 caracteres previos, cruzando statements, así que una REASIGNACIÓN a una variable ya
   * declarada heredaba el LHS del destructuring de arriba. En un archivo donde casi toda
   * línea previa es un `const { data, error } =`, evadía desde casi cualquier ubicación.
   */
  it('una reasignación no hereda el LHS del statement anterior', () => {
    const evasion = [
      "const { data: a, error: e } = await supabase.from('x').select('*');",
      "      yaAviso = await supabase.from('notificaciones').select('id');",
    ].join('\n');
    const [primera, segunda] = lecturas(evasion);
    expect(leeElError(primera.lhs), 'la lectura correcta dejó de reconocerse').toBe(true);
    expect(leeElError(segunda.lhs), 'la reasignación heredó el error de la línea de arriba').toBe(false);
  });

  /**
   * Una flecha no es una asignación. La distinción `(?!=|>)` no evita una EVASIÓN sino un
   * falso positivo: sin ella, un `ids.forEach((id) => supabase.from(...))` se reportaría como
   * lectura muda con LHS `ids.forEach((id) `, y un guard que grita por lo que no es se
   * termina ignorando — que es la falla más cara de las dos.
   */
  it('una flecha no es una asignación', () => {
    const [l] = lecturas('ids.forEach((id) => supabase.from("t").delete());');
    expect(l.lhs, 'el `=>` se leyó como asignación: la query saldría reportada como muda').toBe(null);
  });

  it('ve el LHS aunque el await esté en otra línea', () => {
    const partido = 'const { data: u } =\n  await supabase.from("t")\n    .select("*")';
    const [l] = lecturas(partido);
    expect(l).toBeDefined();
    expect(leeElError(l.lhs)).toBe(false);
  });

  /**
   * El espejo del anterior: el parser tiene que reconocer la forma BUENA partida en dos
   * líneas. Sin este caso, un parser roto que devolviera `lhs: null` para todo pasaría el
   * test de arriba (nada lee el error) y dejaría la lista de mudas vacía por vacuidad.
   */
  it('y reconoce la forma correcta partida en dos líneas', () => {
    const partido = 'const { data: u, error: e } =\n  await supabase.from("t")\n    .select("*")';
    const [l] = lecturas(partido);
    expect(leeElError(l.lhs)).toBe(true);
  });
});

describe('toda lectura de cron/checks.js lee su error', () => {
  it('ninguna descarta el { error }', () => {
    const mudas = CON_ASIGNACION.filter((l) => !leeElError(l.lhs))
      .map((l) => 'cron/checks.js:' + l.linea + '  ' + l.lhs.slice(-70));

    expect(mudas, [
      'Estas lecturas descartan el { error } de supabase-js, que NO lanza.',
      'Sin leerlo, una caída de la base se lee igual que "no hay a quién avisar".',
      'Antes de agregar el guard, decidí QUÉ decide esta lectura:',
      '  · dedup / anti-fatiga → falla ABIERTO: un error reenvía. `if (err) { log; continue; }`',
      '  · población de destinatarios → `if (err) { log; return; }`',
      '  · decisión por usuario dentro del loop → `throw err` (el catch de abajo ya loguea)',
      '  · accesoria (un null degrada, no decide) → SÓLO log. Un continue de más apaga el cron.',
      'Y agregá el caso a tests/cron/lecturas-con-error.test.js: la forma sola no prueba nada.',
    ].join('\n')).toEqual([]);
  });

  /**
   * Las escrituras fire-and-forget son OTRA clase y quedan fuera a propósito: no deciden a
   * quién se le avisa, así que no producen el silencio que este archivo persigue. Lo que sí
   * hacen es perder un ledger (`recordatorios_enviados`, `activacion_nudge_at`,
   * `last_reminder_sent_at`) sin decirlo, y eso es un trabajo separado — anotado en el
   * backlog de confiabilidad, no resuelto acá.
   *
   * El conteo va fijado para que una escritura nueva obligue a decidir, en vez de sumarse en
   * silencio a una excepción que nadie eligió.
   */
  it('las escrituras sin asignación siguen siendo 6 (una nueva pide una decisión, no un default)', () => {
    expect(SIN_ASIGNACION.length, 'líneas: ' + SIN_ASIGNACION.map((l) => l.linea).join(', ')).toBe(6);
  });
});
