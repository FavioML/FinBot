import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard de la FORMA de las excepciones de canal, hermano de `notificaciones-duales.test.js`.
 *
 * Aquel exige que un canal único traiga `motivo`. Éste exige que el motivo sea CIERTO, que es
 * otra pregunta y hasta el 20-ago-2026 no la hacía nadie.
 *
 * La regla que las cinco excepciones venían cumpliendo, escrita en el docblock de
 * `notify-user.js` y en el CLAUDE.md: *la query que selecciona al destinatario exige que NO
 * tenga cuenta web, así que no hay campana donde mostrar nada*. Es lo único que hace honesto
 * mandar por un canal que entrega al 10%.
 *
 * **El modo de falla es que la premisa envejezca sin que el canal se entere**, y ya ocurrió:
 * `checkRecordatorioOnboarding` seleccionaba por `onboarding_completado = false`, y cuando el
 * alta reordenada dejó esa columna en `true` el criterio se cambió por "no anotó nada". El
 * canal y su motivo se quedaron como estaban. La población nueva incluye altas web-first, así
 * que entre el 17 y el 18-ago tres usuarios con cuenta web y `whatsapp IS NULL` salieron
 * `skipped_no_whatsapp` y no se enteró nadie. Ni un test se puso rojo: el `motivo` seguía ahí,
 * la sintaxis seguía bien, y la afirmación era falsa.
 *
 * Lo que este archivo puede y lo que no:
 *
 *   · SÍ: que la función que rodea a cada `SOLO_WHATSAPP` **mire** `supabase_auth_id`. Es una
 *     declaración, no una demostración — no puede saber si la mira bien.
 *   · NO: que el filtro sea correcto. Eso es un test de comportamiento, y para el nudge de
 *     primer gasto vive en `tests/cron/nudge-primer-gasto.test.js`.
 *
 * Aun siendo una declaración sirve: para evadirlo hay que escribir a mano la exención de abajo,
 * y eso es exactamente la conversación que no se tuvo cuando cambió la población.
 */

const RAIZ = process.cwd();
const DIRS = ['cron', 'services', 'routes', 'lib', 'handlers', 'helpers'];
const SUELTOS = ['index.js', 'gmail.js'];

/**
 * Call-sites que declaran `SOLO_WHATSAPP` sin mirar `supabase_auth_id`. Vacía a propósito.
 * Una entrada acá es una decisión de producto que alguien tiene que firmar, no un atajo:
 * significa "le mando por el canal que entrega al 10% a alguien que quizás tiene campana".
 */
const EXENTOS = new Map([]);

/** El conteo fijado: si aparece un canal único nuevo, este archivo lo hace notar. */
const SITIOS_ESPERADOS = 4;

function archivosJs(dir) {
  const out = [];
  const abs = join(RAIZ, dir);
  let entradas;
  try { entradas = readdirSync(abs, { withFileTypes: true }); } catch { return out; }
  for (const e of entradas) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) out.push(...archivosJs(rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

const FUENTES = [...DIRS.flatMap(archivosJs), ...SUELTOS.filter((f) => {
  try { return statSync(join(RAIZ, f)).isFile(); } catch { return false; }
})].map((rel) => ({ rel: rel.replace(/\\/g, '/'), src: readFileSync(join(RAIZ, rel), 'utf8') }));

/**
 * Parte un archivo en funciones de nivel superior. No es un parser: alcanza porque en este repo
 * las funciones de runtime se declaran en la columna 0. Si alguna vez dejan de estarlo, el
 * chequeo de antivacuidad de abajo (cada cuerpo tiene que ser corto y contener el call-site)
 * es lo que lo delata en vez de dejarlo pasar.
 */
function funciones(src) {
  // Las DOS formas de declarar en la columna 0. La arrow salió de un ataque: un call-site nuevo
  // escrito como `const nudge = async (u) => {...}` entre dos `function` se pegaba al cuerpo de
  // la ANTERIOR, así que heredaba su `supabase_auth_id` y ni movía el conteo de sitios.
  const marcas = [...src.matchAll(
    /^(?:(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z0-9_$]+\s*=>))/gm,
  )];
  return marcas.map((m, i) => ({
    nombre: m[1] || m[2],
    cuerpo: src.slice(m.index, i + 1 < marcas.length ? marcas[i + 1].index : src.length),
  }));
}

/**
 * Borra comentarios ANTES de buscar el filtro, y no es paranoia: la primera versión de este
 * archivo no lo hacía y **pasó en verde con la guarda borrada**, porque `maybeWebappInvite`
 * tiene arriba un comentario que dice *"Si tiene supabase_auth_id, ya se logueo en webapp
 * alguna vez"*. O sea que el guard se estaba midiendo contra la documentación del código en
 * vez de contra el código — la misma clase que ya está dos veces en `docs/DEFECTOS.md`
 * (17 y 18-ago-2026), y que en las dos ocasiones se resolvió igual.
 *
 * No maneja `//` dentro de un string ni de una regex. Del lado seguro: borrar de más solo puede
 * poner el guard ROJO por no encontrar el filtro, nunca verde.
 */
function sinComentarios(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Borra el VALOR de `motivo:`, y esta es la segunda evasión que encontró la prueba por mutación
 * — la misma clase que la de los comentarios, un escalón más adentro.
 *
 * Con la guarda de `maybeWebappInvite` borrada, el guard seguía verde porque su propio motivo
 * dice *"el trigger exige supabase_auth_id NULL (arriba)"*. O sea: el guard existe para
 * verificar que esa frase sea cierta, y la frase se estaba verificando a sí misma. Es la
 * tercera aparición de `guard-que-se-mide-contra-su-documentacion` en este repo.
 *
 * NO se borran todos los literales, a propósito: `supabase_auth_id` aparece legítimamente
 * dentro de strings como nombre de COLUMNA (`.is('supabase_auth_id', null)`, y el `.select()`),
 * y eso sí es código que filtra. Lo que no puede contar es la prosa.
 */
function sinMotivos(src) {
  return src.replace(/motivo\s*:\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g, 'motivo: MOTIVO');
}

/**
 * **La pregunta no es "¿aparece la cadena?" sino "¿aparece FILTRANDO?"**, y ese cambio es lo que
 * cierra la clase entera en vez de tapar evasiones de a una.
 *
 * La version anterior buscaba la cadena en el texto y despues iba borrando los lugares donde no
 * valia: comentarios, el valor de `motivo:`, el argumento de `.select(...)`. Cada parche cerraba
 * UNA evasion y la revision adversarial encontraba la siguiente — la cuarta fue mover la lista de
 * columnas a una constante (`.select(COLS_NUDGE)`), que ningun scrubber de literales puede ver, y
 * es un refactor mundano que nadie asocia con un guard. Tambien pasaban: la prosa en un
 * `log.info`, la clave suelta en `datos: { supabase_auth_id }` y una variable
 * `supabase_auth_id_pendiente`.
 *
 * Con lista blanca esas seis mueren juntas, porque ninguna es una de estas dos formas:
 *
 *   · **filtro de PostgREST** — la columna es el sujeto de un `.is/.eq/.neq/.not/.or/...`.
 *     Un `.select()` NO entra: es una PROYECCION. Traer la columna no dice nada sobre a quien
 *     se eligio, y esa distincion es la misma que el guard del MRR termino necesitando.
 *   · **acceso a propiedad** — `u.supabase_auth_id`, o sea una rama de JS mirandola.
 *
 * Sigue siendo una DECLARACION y no una demostracion: no sabe si el filtro esta bien puesto.
 * Eso lo prueba el test de comportamiento (`tests/cron/nudge-primer-gasto.test.js`).
 */
const FILTRO_POSTGREST = /\.(?:is|eq|neq|not|or|filter|match|gt|gte|lt|lte)\(\s*['"`][^'"`]*\bsupabase_auth_id\b/;
const ACCESO_PROPIEDAD = /\.supabase_auth_id\b/;

function filtraPorCuentaWeb(cuerpo) {
  return FILTRO_POSTGREST.test(cuerpo) || ACCESO_PROPIEDAD.test(cuerpo);
}

const SITIOS = [];
for (const { rel, src } of FUENTES) {
  if (rel === 'lib/notify-user.js') continue; // la definición: nombra las constantes, no las usa
  const limpio = sinMotivos(sinComentarios(src));
  for (const fn of funciones(limpio)) {
    if (!/CANALES\.SOLO_WHATSAPP/.test(fn.cuerpo)) continue;
    SITIOS.push({ rel, nombre: fn.nombre, cuerpo: fn.cuerpo, largoArchivo: limpio.length });
  }
}

describe('un canal SOLO_WHATSAPP mira si el destinatario tiene cuenta web', () => {
  it('el barrido encuentra los call-sites (antivacuidad)', () => {
    // Sin esto, romper el regex o el troceo dejaría el archivo verde sin haber mirado nada.
    expect(SITIOS.length).toBe(SITIOS_ESPERADOS);
    // Y cada cuerpo tiene que ser UNA función, no el archivo entero colapsado: si el troceo
    // fallara, un `supabase_auth_id` de cualquier otra función haría pasar a todas.
    //
    // El umbral es RELATIVO al archivo, no un número de bytes: el absoluto (6000) ya se puso
    // rojo con `checkRecordatorioOnboarding` a 7713 por sus comentarios, o sea que castigaba
    // documentar. Lo que hay que distinguir es "una función" de "el archivo entero", y un
    // tercio separa esas dos cosas con aire de sobra (hoy el peor caso está en 12%).
    for (const s of SITIOS) {
      expect(
        s.cuerpo.length / s.largoArchivo,
        `${s.rel}:${s.nombre} ocupa casi todo el archivo: el troceo por función no funcionó`,
      ).toBeLessThan(0.34);
    }
  });

  /**
   * El guard atacado con las SEIS formas que lo evadieron. Ninguna es hipótesis: las tres
   * primeras salieron de mutar call-sites reales y ver el archivo verde con la guarda borrada;
   * las otras tres, de una revisión adversarial dedicada a romperlo.
   *
   * Un guard verde por evasión es indistinguible de un guard verde por corrección, así que estas
   * entradas son lo único que separa las dos cosas. La cuarta es la que enseñó más: mover la
   * lista de columnas a una constante (`.select(COLS_NUDGE)`) es un refactor mundano que nadie
   * asocia con un guard, y ningún scrubber de literales puede verlo. Fue lo que hizo cambiar el
   * enfoque de "borrar donde no vale" a "exigir una forma que filtre".
   */
  const EVASIONES = [
    ['en un comentario', `async function f(u) {\n  // Si tiene supabase_auth_id, no reinvitar.\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
    ['en el propio motivo', `async function f(u) {\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'el trigger exige supabase_auth_id NULL' });\n}\n`],
    ['en un comentario de bloque', `async function f(u) {\n  /* exige supabase_auth_id nulo */\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
    ['en un .select() (proyección, no filtro)', `async function f(u) {\n  const { data } = await supabase.from('usuarios').select('id, whatsapp, supabase_auth_id');\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
    ['en un .select() indirectado por una constante', `async function f(u) {\n  const { data } = await supabase.from('usuarios').select(COLS_NUDGE);\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
    ['en la prosa de un log', `async function f(u) {\n  log.info({ tag: 'X' }, 'destinatario sin supabase_auth_id');\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
    ['como clave suelta de un objeto', `async function f(u) {\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x', datos: { supabase_auth_id: null } });\n}\n`],
    ['dentro de otro identificador', `async function f(u) {\n  const supabase_auth_id_pendiente = true;\n  if (supabase_auth_id_pendiente) return;\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
  ];

  it.each(EVASIONES)('un call-site que solo nombra supabase_auth_id %s NO cuenta', (_como, fuente) => {
    const limpio = sinMotivos(sinComentarios(fuente));
    const fn = funciones(limpio)[0];
    expect(fn, 'el troceo no encontró la función del fixture').toBeTruthy();
    expect(/CANALES\.SOLO_WHATSAPP/.test(fn.cuerpo), 'el fixture perdió su call-site').toBe(true);
    expect(filtraPorCuentaWeb(fn.cuerpo)).toBe(false);
  });

  // Los dos controles POSITIVOS. Sin ellos, un `filtraPorCuentaWeb` que devolviera siempre false
  // pasaría los ocho negativos de arriba y el archivo entero sería verde por vacuidad.
  it.each([
    ['acceso a propiedad', `async function f(u) {\n  if (u.supabase_auth_id) return false;\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
    ['filtro de PostgREST', `async function f(u) {\n  const { data } = await supabase.from('usuarios').select('id').is('supabase_auth_id', null);\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
  ])('un call-site que SÍ lo filtra (%s) cuenta', (_forma, fuente) => {
    const fn = funciones(sinMotivos(sinComentarios(fuente)))[0];
    expect(filtraPorCuentaWeb(fn.cuerpo)).toBe(true);
  });

  it('el troceo ve una arrow function de módulo como su propia función', () => {
    // La evasión estructural: un call-site nuevo escrito como `const x = async (u) => {...}`
    // entre dos `function` se pegaba al cuerpo de la ANTERIOR, heredaba su filtro, y ni siquiera
    // movía el conteo de sitios.
    const fuente = `async function anterior(u) {\n  if (u.supabase_auth_id) return false;\n}\n\nconst nuevo = async (u) => {\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n};\n`;
    const conCallSite = funciones(sinMotivos(sinComentarios(fuente)))
      .filter((f) => /CANALES\.SOLO_WHATSAPP/.test(f.cuerpo));
    expect(conCallSite.map((f) => f.nombre)).toEqual(['nuevo']);
    expect(filtraPorCuentaWeb(conCallSite[0].cuerpo)).toBe(false);
  });

  it.each(SITIOS.map((s) => [`${s.rel}:${s.nombre}`, s]))('%s', (_id, sitio) => {
    if (EXENTOS.has(`${sitio.rel}:${sitio.nombre}`)) return;
    expect(
      filtraPorCuentaWeb(sitio.cuerpo),
      `${sitio.rel} → ${sitio.nombre}() manda por SOLO_WHATSAPP sin mirar supabase_auth_id. ` +
      'Su `motivo` afirma que el destinatario no tiene cuenta web; nada lo verifica. ' +
      'O agregá el filtro, o pasá a AMBOS, o declaralo en EXENTOS con el porqué.',
    ).toBe(true);
  });
});
