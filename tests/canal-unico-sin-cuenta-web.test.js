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
  const marcas = [...src.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)];
  return marcas.map((m, i) => ({
    nombre: m[1],
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
 * Borra el argumento de `.select(...)`, y es la tercera evasión que salió por mutación.
 *
 * Con el `.is('supabase_auth_id', null)` borrado, `checkActivacionDia2` seguía verde porque su
 * `.select('id, whatsapp, nombre, supabase_auth_id, activacion_nudge_at')` sigue nombrando la
 * columna. **Un select es una PROYECCIÓN, no un filtro**: traer la columna no dice nada sobre a
 * quién se eligió. La distinción es la misma que el guard del MRR terminó necesitando.
 *
 * Lo que SÍ cuenta después de esto: `.is('supabase_auth_id', null)`, `.eq(...)`, `.not(...)` —
 * donde la columna es el sujeto de un filtro — y el acceso `u.supabase_auth_id` de una rama.
 */
function sinSelects(src) {
  return src.replace(/\.select\(\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g, ".select('SELECT'");
}

const SITIOS = [];
for (const { rel, src } of FUENTES) {
  if (rel === 'lib/notify-user.js') continue; // la definición: nombra las constantes, no las usa
  const limpio = sinSelects(sinMotivos(sinComentarios(src)));
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
   * El guard atacado con las dos formas que YA lo evadieron. No son hipótesis: las dos salieron
   * de mutar los call-sites reales y ver el archivo en verde con la guarda borrada.
   *
   * Un guard verde por evasión es indistinguible de un guard verde por corrección, así que
   * estas dos entradas son lo único que separa las dos cosas.
   */
  const EVASIONES = [
    ['en un comentario', `async function f(u) {\n  // Si tiene supabase_auth_id, no reinvitar.\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
    ['en el propio motivo', `async function f(u) {\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'el trigger exige supabase_auth_id NULL' });\n}\n`],
    ['en un comentario de bloque', `async function f(u) {\n  /* exige supabase_auth_id nulo */\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
  ];

  it.each(EVASIONES)('un call-site que solo nombra supabase_auth_id %s NO cuenta', (_como, fuente) => {
    const limpio = sinSelects(sinMotivos(sinComentarios(fuente)));
    const fn = funciones(limpio)[0];
    expect(fn, 'el troceo no encontró la función del fixture').toBeTruthy();
    expect(/CANALES\.SOLO_WHATSAPP/.test(fn.cuerpo), 'el fixture perdió su call-site').toBe(true);
    expect(/supabase_auth_id/.test(fn.cuerpo)).toBe(false);
  });

  it('y un call-site que SÍ lo filtra en código cuenta (control positivo)', () => {
    const fuente = `async function f(u) {\n  if (u.supabase_auth_id) return false;\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`;
    const fn = funciones(sinSelects(sinMotivos(sinComentarios(fuente))))[0];
    expect(/supabase_auth_id/.test(fn.cuerpo)).toBe(true);
  });

  it.each(SITIOS.map((s) => [`${s.rel}:${s.nombre}`, s]))('%s', (_id, sitio) => {
    if (EXENTOS.has(`${sitio.rel}:${sitio.nombre}`)) return;
    expect(
      /supabase_auth_id/.test(sitio.cuerpo),
      `${sitio.rel} → ${sitio.nombre}() manda por SOLO_WHATSAPP sin mirar supabase_auth_id. ` +
      'Su `motivo` afirma que el destinatario no tiene cuenta web; nada lo verifica. ' +
      'O agregá el filtro, o pasá a AMBOS, o declaralo en EXENTOS con el porqué.',
    ).toBe(true);
  });
});
