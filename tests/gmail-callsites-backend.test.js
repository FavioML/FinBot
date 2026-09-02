import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * El hermano de `webapp/src/lib/gmail-callsites.test.ts`, para el árbol del backend.
 *
 * Existe por una medición: al arreglar las tres copias del Neto Score, DOS quedaron protegidas
 * contra reincidencia (las de la webapp, que barre su guard) y la tercera no. Una revisión
 * adversarial revirtió `services/neto-score.js` a `if (usuario?.gmail_access_token) score += 25`
 * y corrió la suite entera: **164 archivos, 2978 tests, todo en verde**, con `indexarGmail`
 * quedando como import muerto y nadie notándolo. Y esa es justamente la copia que corre en el
 * cron diario que asienta `neto_scores`.
 *
 * La regla es la misma que del lado de la webapp: donde la columna legacy se LEE, la otra
 * fuente (`gmail_cuentas` o `indexarGmail`) tiene que estar en la misma línea o en una vecina.
 *
 * **`handlers/webhook.js` y `handlers/onboarding.js` estuvieron exentos UN DÍA, y la exención
 * era la parte peligrosa del arreglo.** El 01-sep se declararon con un motivo que era cierto
 * (eligen copy, y unirlos costaba un round-trip en el camino del webhook) y al día siguiente
 * se arreglaron igual. Con la exención puesta, revertir cualquiera de los dos a la columna
 * legacy dejaba el guard en verde — medido. Una exención que sobrevive a su motivo no es una
 * nota vieja: es un archivo que el guard dejó de mirar.
 */

const RAIZ = join(process.cwd());
const DIRS = ['services', 'handlers', 'lib', 'routes', 'cron', 'helpers'];

/**
 * **La RAÍZ, no recursiva, y es donde vive `gmail.js`.** El barrido nació sin ella y el
 * agujero era el peor posible: `gmail.js` es hoy el DUEÑO de la unión (`tieneGmailConectado`,
 * `leerCorreosBancarios`), o sea el único archivo cuya reversión rompe a todos los demás a la
 * vez, y quedaba invisible. Es el mismo hueco que `plata-validada.test.js` ya documenta con
 * estas palabras para su propio barrido; lo repetí igual.
 */
function archivosRaiz() {
  return readdirSync(RAIZ, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.js$/.test(e.name))
    .map((e) => e.name);
}

/**
 * Exentos, con su razón. Una excepción sin razón es un guard apagado, y una que sobrevive a su
 * motivo es un hueco.
 */
const EXENTOS = new Map([
  ['lib/gmail-conectado.js', 'es el dueño de la definición (la parte pura, sin I/O)'],
  [
    'gmail.js',
    'es el dueño del ALMACÉN legacy y de la unión con I/O (`tieneGmailConectado`, ' +
      '`leerCorreosBancarios`, `cargarTokens`): escribe la columna al guardar tokens, la lee ' +
      'para autenticar, y define el corte que evita el round-trip. Marcarlo sería marcar al ' +
      'único archivo que TIENE que tocarla.',
  ],
  [
    'services/gmail-scanner.js',
    'arma la unión a mano y a propósito: son DOS queries que se abortan juntas, con su propio ' +
      'manejo de error por mitad. Es el sitio que define la unión, no uno que la consume.',
  ],
]);

function archivosDe(dir) {
  const out = [];
  const abs = join(RAIZ, dir);
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...archivosDe(rel));
    else if (/\.js$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** Vacía el contenido de las cadenas: ahí la columna es una proyección, no una decisión. */
function sinCadenas(src) {
  return src
    .replace(/\[\s*(['"`])gmail_access_token\1\s*\]/g, '.gmail_access_token')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => m[0] + m[0]);
}

function sinComentarios(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

const leeLaOtraFuente = (s) =>
  s.includes('gmail_cuentas') || s.includes('indexarGmail') || s.includes('obtenerCuentasGmail');

/** `gmail_access_token: null` es escritura (limpiar el token), no lectura. */
function esLectura(linea) {
  if (!linea.includes('gmail_access_token')) return false;
  return linea.replace(/gmail_access_token\s*:\s*null/g, '').includes('gmail_access_token');
}

/**
 * Cuántas líneas alrededor cuentan como "al lado".
 *
 * Empezó en 1 y no alcanzaba: `resolverCorreoConectado` (`handlers/message-processor.js`) hace
 * la unión correcta repartida en tres líneas —el corto por el token legacy, un `try`, y recién
 * ahí la consulta a `gmail_cuentas`— y salía marcada como si mirara una sola fuente. Dos líneas
 * cubren esa forma. Subirlo más empieza a tapar decisiones reales: con la ventana lo bastante
 * grande, cualquier archivo que consulte la tabla en algún lado queda absuelto entero, que es
 * exactamente el guard por ARCHIVO que esta versión vino a reemplazar.
 */
const VENTANA = 2;

function decisionesSoloLegacy(src) {
  const lineas = sinCadenas(sinComentarios(src)).split('\n');
  const vecindad = (i) => lineas.slice(Math.max(0, i - VENTANA), i + VENTANA + 1).join('\n');
  return lineas
    .map((l, i) => ({ l, ctx: vecindad(i) }))
    .filter(({ l }) => esLectura(l))
    .filter(({ ctx }) => !leeLaOtraFuente(ctx))
    .map(({ l }) => l.trim());
}

const archivos = [...DIRS.flatMap(archivosDe), ...archivosRaiz()];
const conLaColumna = archivos.filter((f) =>
  readFileSync(join(RAIZ, f), 'utf8').includes('gmail_access_token'),
);
const infractores = archivos
  .filter((f) => !EXENTOS.has(f))
  .filter((f) => decisionesSoloLegacy(readFileSync(join(RAIZ, f), 'utf8')).length > 0);

describe('la columna legacy de Gmail no decide sola en el backend', () => {
  it('el barrido alcanza el árbol y encuentra la columna (antivacuidad)', () => {
    expect(archivos.length).toBeGreaterThan(50);
    expect(archivos).toContain('services/neto-score.js');
    expect(archivos).toContain('services/gmail-scanner.js');
    // La raíz: el hueco que tuvo este barrido al nacer, y donde vive el dueño de la unión.
    expect(archivos).toContain('gmail.js');
    // Y que la raíz aporte más de un archivo: si `archivosRaiz` devolviera solo el que se
    // nombra arriba, el barrido de la raíz estaría midiendo una lista escrita a mano.
    expect(archivosRaiz().length).toBeGreaterThan(1);
    // Y que de verdad la vea en algún lado: un barrido que no encuentra nada no puede
    // distinguirse de uno que encuentra todo limpio.
    expect(conLaColumna.length).toBeGreaterThan(3);
  });

  it('las exenciones siguen vivas y siguen nombrando la columna', () => {
    for (const f of EXENTOS.keys()) {
      expect(archivos, `exención muerta: ${f}`).toContain(f);
      expect(readFileSync(join(RAIZ, f), 'utf8')).toContain('gmail_access_token');
    }
  });

  it('el detector distingue leer de escribir y de proyectar (antivacuidad)', () => {
    expect(decisionesSoloLegacy('if (usuario?.gmail_access_token) score += 25;')).toHaveLength(1);
    expect(decisionesSoloLegacy('const { gmail_access_token: t } = usuario;')).toHaveLength(1);
    expect(decisionesSoloLegacy("if (u['gmail_access_token']) score += 25;")).toHaveLength(1);
    expect(decisionesSoloLegacy('.update({ gmail_access_token: null })')).toHaveLength(0);
    expect(decisionesSoloLegacy(".select('id, gmail_access_token')")).toHaveLength(0);
    expect(
      decisionesSoloLegacy('const g = indexarGmail([u], c);\nif (u.gmail_access_token) {}'),
    ).toHaveLength(0);
  });

  it('nadie lee la columna legacy para decidir', () => {
    expect(infractores).toEqual([]);
  });

  /**
   * Y el guard POSITIVO, que es lo que cierra la evasión por el archivo exento.
   *
   * El barrido de arriba es NEGATIVO: busca la cadena `gmail_access_token` fuera de su dueño.
   * Una revisión adversarial lo evadió definiendo el predicado legacy-only DENTRO de `gmail.js`
   * —que está exento por ser el dueño del almacén— y llamándolo desde `webhook.js`, con un
   * motivo perfectamente creíble ("el round-trip es caro"). El archivo deja de contener la
   * cadena, así que un barrido por líneas no puede verlo por construcción. Suite en verde con
   * el saludo de "modo manual" volviendo a caerle a quien tiene Gmail.
   *
   * Un guard positivo no se evade renombrando: exige ver la respuesta CORRECTA, no la ausencia
   * de la incorrecta.
   */
  it('los sitios que preguntan por Gmail usan tieneGmailConectado', () => {
    const OBLIGADOS = ['handlers/webhook.js', 'handlers/onboarding.js', 'handlers/message-processor.js'];
    const sinElHelper = OBLIGADOS.filter(
      (f) => !sinComentarios(readFileSync(join(RAIZ, f), 'utf8')).includes('tieneGmailConectado('),
    );
    expect(sinElHelper).toEqual([]);
  });

  /**
   * Y que el score CONSULTE la tabla. El guard de líneas no puede ver una query que falta:
   * borrar el `from('gmail_cuentas')` y dejar el `indexarGmail` con un array vacío cumple todo
   * lo de arriba y reintroduce el bug entero.
   */
  it('el Neto Score lee gmail_cuentas', () => {
    const src = sinComentarios(readFileSync(join(RAIZ, 'services/neto-score.js'), 'utf8'));
    expect(src).toContain("from('gmail_cuentas')");
    expect(src).toContain('indexarGmail(');
    // Y que el error de esa lectura ABORTE en vez de degradar en silencio: este cálculo se
    // persiste, así que un hipo de red dejaría un score falso asentado.
    expect(src).toMatch(/eGmail/);
  });
});
