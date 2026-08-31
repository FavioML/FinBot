import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Declarar el canal de correo NO alcanza: hay que traer la columna.
 *
 * `notificarUsuario` no lee la base — decisión tomada, revertida una vez, y escrita en el
 * docblock de `lib/notify-user.js` con sus 37 tests en rojo. El `to` lo pasa el LLAMADOR. La
 * consecuencia práctica es una regla que no se deduce leyendo el call-site: **si tu cron
 * declara `email: { to: u.email }`, el `.select()` que trajo a `u` tiene que incluir la
 * columna `email`**.
 *
 * Olvidarla no rompe nada visible. `u.email` queda `undefined`, `to` cae en `null`,
 * `enviarEmail` hace no-op y deja `skipped_no_email` en `notification_deliveries`. O sea: un
 * canal apagado con cara de canal encendido, y el rastro que deja es exactamente el mismo que
 * el de un usuario que de verdad no tiene correo.
 *
 * **No es hipotético: es el bug que cerró el ítem 17 del backlog de confiabilidad.**
 * `checkTrialExpiry` mandaba sus tres avisos —los únicos del producto que piden plata— con
 * dos `select` que no traían `email`. Nada se puso rojo, y por WhatsApp esos avisos
 * entregaron 1 de 80 en 30 días.
 *
 * Lo que este archivo puede y lo que no:
 *
 *   · SÍ: que la función que DECLARA el correo tenga a la vista un `.select()` literal que
 *     nombre la columna, o que delegue en un helper declarado que sí la nombre.
 *   · NO: que la columna sea de la tabla correcta, ni que el `to` salga de esa fila. Eso es un
 *     test de comportamiento. Esto es una DECLARACIÓN, igual que sus dos hermanos
 *     (`notificaciones-duales`, `canal-unico-sin-cuenta-web`) — pero para evadirla hay que
 *     escribir a mano una entrada abajo, y eso es la conversación que no se tuvo.
 *
 * Estricto a propósito con `.select('*')`: sobre `usuarios` traería la columna, pero desde acá
 * no se puede saber sobre qué tabla es, y un guard que no puede decidir falla cerrado.
 */

const RAIZ = process.cwd();

/**
 * Lista NEGRA, mismo criterio que `canal-unico-sin-cuenta-web.test.js`: con lista blanca un
 * directorio de runtime nuevo queda invisible EN SILENCIO, y el conteo de sitios tampoco se
 * mueve, así que la antivacuidad no lo delata.
 */
const EXCLUIDOS = new Set([
  'node_modules', '.git', '.next', '.claude',
  'webapp',                                    // TypeScript, con su propia suite
  'tests',                                     // este archivo y sus vecinos
  'qa-e2e',                                    // harness: corre a mano o en CI, nunca en el server
  'migrations', 'docs', 'assets', 'content',   // no ejecutan JS de runtime
  'scripts', 'tasks',                          // one-shot operativos, no le escriben a usuarios
]);

/**
 * Emisores cuyo `.select()` vive en OTRA función, con el nombre del helper que lo tiene.
 *
 * No es un permiso: el guard va a buscar ese helper y a exigirle la columna. Si el helper no
 * existe, o dejó de traer `email`, esta entrada se pone roja igual. Una exención que no se
 * verifica es un `expect(true)` con prosa.
 */
const SELECT_EN_HELPER = new Map([
  // 31-ago-2026: era `checkRecordatorioDeudas` con `obtenerDeudasProximasVencer`. El correo
  // por deuda se fue de ahí (mandaba uno por cada deuda que vencía el mismo día) y renació
  // agrupado por persona en el resumen semanal, con su propio helper y su propia ventana.
  // Aquel cron ya no declara correo, así que el barrido dejó de encontrarlo: dejar la entrada
  // vieja habría sido una exención fantasma, verde por no tener a quién mirar.
  ['cron/checks.js:checkResumenDeudasSemanal', 'obtenerDeudasParaResumenSemanal'],
  ['lib/support-tickets.js:responderTicket', 'estadoVentana'],
]);

function archivosJs(dir) {
  const out = [];
  let entradas;
  try { entradas = readdirSync(join(RAIZ, dir || '.'), { withFileTypes: true }); } catch { return out; }
  for (const e of entradas) {
    if (EXCLUIDOS.has(e.name)) continue;
    const rel = dir ? join(dir, e.name) : e.name;
    if (e.isDirectory()) out.push(...archivosJs(rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

const FUENTES = archivosJs('')
  .map((rel) => ({ rel: rel.replace(/\\/g, '/'), src: readFileSync(join(RAIZ, rel), 'utf8') }));

/** Comentarios fuera ANTES de buscar nada: un `// trae email` no es un select. */
function sinComentarios(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Mismo partidor que `canal-unico-sin-cuenta-web.test.js`, y por los mismos ataques. */
function funciones(src) {
  const marcas = [...src.matchAll(
    /^(?:(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|(?:const|let|var|(?:module\.)?exports\.|this\.)\s*([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z0-9_$]+\s*=>))/gm,
  )];
  return marcas.map((m, i) => ({
    nombre: m[1] || m[2],
    cuerpo: src.slice(m.index, i + 1 < marcas.length ? marcas[i + 1].index : src.length),
  }));
}

/**
 * Los argumentos de cada `notificarUsuario(...)`, con paréntesis balanceados. La unidad de
 * análisis es la LLAMADA y no el archivo, por el mismo motivo que en `notificaciones-duales`:
 * `email: { type: 'string' }` de un JSON Schema no es un canal de correo.
 */
function argumentosDelChokepoint(src) {
  const out = [];
  for (const m of src.matchAll(/\bnotificarUsuario\s*\(/g)) {
    let i = m.index + m[0].length;
    const desde = i;
    let prof = 1;
    while (i < src.length && prof > 0) {
      if (src[i] === '(') prof++;
      else if (src[i] === ')') prof--;
      i++;
    }
    out.push(src.slice(desde, i));
  }
  return out;
}

/**
 * Cuántas llamadas al chokepoint declaran correo dentro de esta función.
 *
 * **Se CUENTAN, no se detectan.** La primera versión preguntaba "¿declara correo?" y "¿hay
 * algún select con `email`?", y una revisión adversarial la mató en el acto: `checkTrialExpiry`
 * tiene DOS call-sites de correo alimentados por DOS selects distintos, así que sacarle la
 * columna a **cualquiera de los dos** dejaba el guard en verde — el otro select lo tapaba.
 * O sea que el guard escrito para cerrar el ítem 17 dejaba pasar el mismo bug, en la misma
 * función que nombra en su antivacuidad.
 *
 * **No exige que sea un literal de objeto, y ésa fue la segunda evasión.** La versión anterior
 * pedía `email\s*:\s*\{`, así que el refactor más natural del mundo —`email: u.email ? { to,
 * asunto } : null`— hacía que la llamada dejara de contarse: el conteo bajaba a 1, el otro
 * select lo cubría, y los 14 tests quedaban verdes con el correo de d11/d14 muerto. Es
 * exactamente el defecto del 28-ago-2026 que ya está en `docs/DEFECTOS.md` ("pasé el `email`
 * como ternario y el guard no pudo verificar estáticamente"), en otro guard.
 *
 * Contar cualquier `email:` puede sobre-contar (un `datos: { email: x }` entraría), y se elige
 * ese lado a propósito: sobre-contar pide un select de más, sub-contar apaga un canal.
 */
const llamadasConCorreo = (cuerpo) =>
  argumentosDelChokepoint(cuerpo).filter((a) => /\bemail\s*:/.test(a)).length;

/**
 * Cuántos `.select()` con argumento LITERAL nombran la columna.
 *
 * El literal es la condición, no un detalle: `.select(COLS_NUDGE)` no se puede resolver desde
 * acá, así que no cuenta y el sitio se marca. Es la misma decisión de fallar cerrado que toma
 * el detector de asuntos de `notificaciones-duales` con `email: opts`.
 *
 * La regla es **un select por call-site**, que es lo más fino que se puede afirmar sin atar
 * cada `to:` a la query que lo produjo. Atarlos de verdad pide resolver el binding del `for
 * (const usuario of X)`, y acá los dos loops llaman `usuario` a su variable: el nombre no
 * separa nada. Lo que sí separa es el conteo, y alcanza para el modo de falla real (alguien
 * edita UNA de las queries). Si algún día una sola query alimenta dos call-sites, el guard va
 * a pedir una entrada en `SELECT_EN_HELPER`, que es la conversación correcta.
 *
 * **Y la columna tiene que salir de `usuarios`, que fue la tercera evasión.** Contar cualquier
 * select con la palabra `email` deja que una query de otra tabla cubra un call-site: la
 * revisión adversarial dejó los 14 tests en verde quitándole `email` al select del trial y
 * agregando en la misma función un `.from('referidos').select('id, email')`, con el correo de
 * d11/d14 muerto. Por eso se matchea el par `.from(tabla)` + `.select(literal)`, y cuenta sólo
 * si la tabla es `usuarios` o el literal trae un embed de `usuarios(...)` (la forma del cron de
 * deudas, que lee desde `deudas`).
 *
 * El par tiene que estar encadenado directo: un `.from('x').eq(...).select(...)` no matchea y
 * no cuenta. Falla cerrado, que es el lado correcto.
 */
const PAR_FROM_SELECT = /\.from\(\s*(['"`])([^'"`]*)\1\s*\)\s*\.select\(\s*(['"`])([\s\S]*?)\3/g;

function selectsConLaColumna(cuerpo) {
  let n = 0;
  for (const m of cuerpo.matchAll(PAR_FROM_SELECT)) {
    const [, , tabla, , literal] = m;
    if (!/\bemail\b/.test(literal)) continue;
    if (tabla === 'usuarios' || /\busuarios\b\s*!?\w*\s*\(/.test(literal)) n++;
  }
  return n;
}

const CON_CORREO = [];
for (const { rel, src } of FUENTES) {
  if (rel === 'lib/notify-user.js' || rel === 'lib/email.js') continue;   // definición y transporte
  const limpio = sinComentarios(src);
  for (const fn of funciones(limpio)) {
    if (llamadasConCorreo(fn.cuerpo) === 0) continue;
    CON_CORREO.push({ rel, nombre: fn.nombre, cuerpo: fn.cuerpo });
  }
}

describe('el detector decide, y se le ve decidir en las dos direcciones', () => {
  const conSelect = "async function f(u) {\n  const { data } = await supabase.from('usuarios').select('id, whatsapp, email');\n  await notificarUsuario({ email: { to: u.email, asunto: 'x' } });\n}\n";
  const sinSelect = "async function f(u) {\n  const { data } = await supabase.from('usuarios').select('id, whatsapp');\n  await notificarUsuario({ email: { to: u.email, asunto: 'x' } });\n}\n";
  const enComentario = "async function f(u) {\n  // el select de arriba ya trae email\n  const { data } = await supabase.from('usuarios').select('id, whatsapp');\n  await notificarUsuario({ email: { to: u.email, asunto: 'x' } });\n}\n";
  const indirecto = "async function f(u) {\n  const { data } = await supabase.from('usuarios').select(COLS);\n  await notificarUsuario({ email: { to: u.email, asunto: 'x' } });\n}\n";
  const embebido = "async function f(u) {\n  const { data } = await supabase.from('deudas').select('*, usuarios!inner(whatsapp, email)');\n  await notificarUsuario({ email: { to: u.email, asunto: 'x' } });\n}\n";
  const estrella = "async function f(u) {\n  const { data } = await supabase.from('usuarios').select('*');\n  await notificarUsuario({ email: { to: u.email, asunto: 'x' } });\n}\n";
  const cuerpoDe = (fuente) => funciones(sinComentarios(fuente))[0].cuerpo;

  // Dos call-sites alimentados por dos queries, que es la forma exacta de `checkTrialExpiry`.
  // Es el caso que la primera versión de este archivo NO veía.
  const dosYDos = "async function f(u) {\n"
    + "  const a = await supabase.from('usuarios').select('id, email');\n"
    + "  await notificarUsuario({ email: { to: u.email, asunto: 'x' } });\n"
    + "  const b = await supabase.from('usuarios').select('id, plan, email');\n"
    + "  await notificarUsuario({ email: { to: u.email, asunto: 'y' } });\n}\n";
  const dosYUno = dosYDos.replace("'id, plan, email'", "'id, plan'");

  it.each([
    ['la columna nombrada', conSelect, 1],
    ['la columna dentro de un embed', embebido, 1],
    ['dos selects que la traen', dosYDos, 2],
  ])('cuenta %s', (_c, fuente, n) => expect(selectsConLaColumna(cuerpoDe(fuente))).toBe(n));

  it.each([
    ['un select que no la trae', sinSelect],
    ['la columna sólo en un comentario', enComentario],
    ['un select indirectado por constante', indirecto],
    ['un select con asterisco', estrella],
  ])('NO cuenta %s', (_c, fuente) => expect(selectsConLaColumna(cuerpoDe(fuente))).toBe(0));

  it('dos call-sites con un solo select cubierto NO alcanzan (la evasión que mató a la v1)', () => {
    // Con la regla vieja ("¿hay ALGÚN select con email?") esto pasaba en verde y el segundo
    // aviso salía sin correo para todo el mundo, sin que nada se pusiera rojo.
    expect(llamadasConCorreo(cuerpoDe(dosYUno))).toBe(2);
    expect(selectsConLaColumna(cuerpoDe(dosYUno))).toBe(1);
    expect(selectsConLaColumna(cuerpoDe(dosYUno)) >= llamadasConCorreo(cuerpoDe(dosYUno))).toBe(false);
    // Y la versión completa sí alcanza, para que la regla no sea un "siempre falla".
    expect(selectsConLaColumna(cuerpoDe(dosYDos)) >= llamadasConCorreo(cuerpoDe(dosYDos))).toBe(true);
  });

  it('un canal declarado con ternario CUENTA como call-site (evasión 2)', () => {
    // `email: u.email ? {...} : null` es el refactor natural de "no declares el canal si no
    // hay dirección". Con la regla vieja (`email\s*:\s*\{`) dejaba de contarse, y el select de
    // al lado tapaba el hueco. Ojo: `notificaciones-duales` marca esta forma por otro motivo
    // (no puede verificar el asunto), y por eso NO es la forma a escribir — pero un guard no
    // puede apoyarse en que el otro esté mirando.
    const ternario = "async function f(u) {\n"
      + "  const a = await supabase.from('usuarios').select('id, whatsapp');\n"
      + "  await notificarUsuario({ email: u.email ? { to: u.email, asunto: 'x' } : null });\n}\n";
    expect(llamadasConCorreo(cuerpoDe(ternario))).toBe(1);
    expect(selectsConLaColumna(cuerpoDe(ternario))).toBe(0);
  });

  it('un select de OTRA tabla no cubre a nadie (evasión 3)', () => {
    // La revisión adversarial dejó el guard verde así: le sacó `email` al select del trial y
    // agregó una query plausible de otra tabla que sí lo nombra.
    const otraTabla = "async function f(u) {\n"
      + "  const a = await supabase.from('usuarios').select('id, whatsapp');\n"
      + "  const r = await supabase.from('referidos').select('id, email').eq('activo', true);\n"
      + "  await notificarUsuario({ email: { to: u.email, asunto: 'x' } });\n}\n";
    expect(selectsConLaColumna(cuerpoDe(otraTabla))).toBe(0);
    // Y el embed desde otra tabla SÍ cuenta, que es la forma real del cron de deudas.
    expect(selectsConLaColumna(cuerpoDe(embebido))).toBe(1);
  });

  it('sólo mira llamadas al chokepoint, no cualquier `email:` del archivo', () => {
    const schema = "async function f(u) {\n  const T = { properties: { email: { type: 'string' } } };\n  await notificarUsuario({ canales: 'ambos' });\n}\n";
    expect(llamadasConCorreo(cuerpoDe(schema))).toBe(0);
    expect(llamadasConCorreo(cuerpoDe(conSelect))).toBe(1);
  });
});

describe('todo emisor de correo trae la columna que su `to` necesita', () => {
  it('el barrido encuentra los emisores conocidos (antivacuidad)', () => {
    // Sin esto el archivo pasa por vacuidad el día que el partidor de funciones deje de
    // matchear — y encima se vería sano, porque "cero emisores" no llama la atención.
    const ids = CON_CORREO.map((s) => `${s.rel}:${s.nombre}`);
    expect(ids).toContain('cron/checks.js:checkTrialExpiry');
    expect(ids).toContain('cron/checks.js:checkResumenDeudasSemanal');
    // Y el que DEJÓ de mandar correo no puede volver a aparecer sin que alguien lo decida: si
    // reaparece acá es porque se le devolvió el `email:` deuda por deuda, que es exactamente
    // la ráfaga que se sacó (4 correos en 11 segundos a un usuario con 6 deudas).
    expect(ids).not.toContain('cron/checks.js:checkRecordatorioDeudas');
    expect(ids).toContain('lib/support-tickets.js:responderTicket');
  });

  it('cada helper declarado existe y sigue trayendo la columna', () => {
    // La exención no es un permiso. Si `obtenerDeudasProximasVencer` deja de traer `email`,
    // el aviso de deuda se apaga en silencio y esta línea es lo único que lo dice.
    for (const [id, helper] of SELECT_EN_HELPER) {
      const encontrados = FUENTES.flatMap(({ rel, src }) =>
        funciones(sinComentarios(src)).filter((f) => f.nombre === helper).map((f) => ({ rel, ...f })));
      expect(encontrados.length, `${id}: no existe ninguna función llamada ${helper}()`).toBeGreaterThanOrEqual(1);
      // La exención cubre UN call-site. Si el emisor gana un segundo aviso por correo, el
      // chequeo del helper (que sólo pide "el helper trae la columna") volvería a colapsar N
      // sitios en uno — el mismo hueco de la v1, mudado a la lista de exenciones.
      const sitio = CON_CORREO.find((s) => `${s.rel}:${s.nombre}` === id);
      expect(sitio, `${id} está exento pero el barrido no lo encuentra`).toBeTruthy();
      expect(
        llamadasConCorreo(sitio.cuerpo),
        `${id} declara correo en más de una llamada, y la exención sólo verifica UN select ` +
        `(el de ${helper}()). Decidí de dónde sale la dirección del segundo aviso.`,
      ).toBe(1);
      expect(
        encontrados.some((f) => selectsConLaColumna(f.cuerpo) > 0),
        `${id} delega su select en ${helper}(), y ${helper}() ya no trae la columna 'email'. ` +
        'El aviso sigue declarando el canal y no manda ningún correo: `to` queda undefined y ' +
        'la fila sale `skipped_no_email`, indistinguible de un usuario sin dirección.',
      ).toBe(true);
    }
  });

  it.each(CON_CORREO.map((s) => [`${s.rel}:${s.nombre}`, s]))('%s', (id, sitio) => {
    if (SELECT_EN_HELPER.has(id)) return;   // verificado en el caso de arriba
    const llamadas = llamadasConCorreo(sitio.cuerpo);
    const selects = selectsConLaColumna(sitio.cuerpo);
    expect(
      selects >= llamadas,
      `${sitio.rel} → ${sitio.nombre}() declara el canal de correo en ${llamadas} llamada(s) ` +
      `pero sólo ${selects} de sus '.select()' nombran la columna 'email'. ` +
      '`notificarUsuario` NO la lee de la base (ver el bloque de `cuenta_borrada_at` en ' +
      'lib/notify-user.js): el `to` lo pasa el llamador. Sin la columna, `to` es undefined, no ' +
      'sale ningún correo, y el rastro es el mismo que el de alguien que no tiene dirección. ' +
      'Agregá `email` al select que falta, o declará el helper que lo trae en SELECT_EN_HELPER.',
    ).toBe(true);
  });
});
