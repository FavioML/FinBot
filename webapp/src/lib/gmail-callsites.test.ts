import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, sep } from 'path';

/**
 * "¿Tiene Gmail conectado?" se responde en UN solo lugar.
 *
 * El dato tiene dos almacenes: `usuarios.gmail_access_token` (legacy) y `gmail_cuentas` (el
 * actual). `services/gmail-scanner.js` lee los dos desde hace meses; el panel admin, la ficha
 * de usuario, la métrica de adopción y el Neto Score se quedaron mirando solo la columna vieja,
 * y durante ese tiempo la pantalla dijo "sin Gmail" sobre gente a la que el cron sí le
 * escaneaba la bandeja. Medido el 2026-09-01: 6 usuarios habían conectado, 3 seguían activos,
 * la columna tenía 2.
 *
 * **Este guard existe porque el arreglo por sí solo no impide la reincidencia.** Una revisión
 * adversarial lo demostró: revirtiendo la ruta a `indexarGmail(usuarios, [])` —el bug original,
 * tal cual— la suite entera quedaba en verde, porque `gmail-conectado.test.ts` prueba la
 * FUNCIÓN y nadie miraba los call-sites. Es el mismo agujero que `admin-revenue-callsites`
 * cierra del lado del dinero.
 *
 * **La regla es la propiedad, no una lista de archivos**: donde la columna legacy se LEE, la
 * otra fuente tiene que estar al lado (`gmail_cuentas` o `indexarGmail`, en la misma línea o en
 * una vecina). Proyectarla en un `select` no cuenta —hay que pedirla para poder unirla— y
 * escribirla en `null` tampoco, que es limpiar el token al desactivar una cuenta.
 *
 * Cuando se escribió encontró dos sitios que nadie estaba mirando: `api/score/route.ts` y
 * `api/score/backfill/route.ts` daban los 25 puntos de "Gmail conectado" del Neto Score contra
 * la columna vieja, o sea que se los negaban a quien tiene la conexión viva. No era una
 * pantalla de admin: era el puntaje que ve el usuario.
 */

const SRC = join(process.cwd(), 'src');

/** Exentos, con su razón. Una excepción sin razón es un guard apagado. */
const EXENTOS = new Map<string, string>([
  ['/src/lib/gmail-conectado.ts', 'es el dueño de la definición'],
]);

function archivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...archivosTs(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => p.replace(process.cwd(), '').split(sep).join('/');
const esTest = (p: string) => /\.test\.tsx?$/.test(p);

/**
 * Vacía el contenido de las cadenas literales.
 *
 * Una columna nombrada DENTRO de una cadena es una proyección —la lista que se le pide a
 * PostgREST— y nunca decide nada. Empezó cubriendo solo `.select('...')` y se quedó corto: esta
 * webapp también proyecta con `requireNetoUser('id, plan, gmail_access_token, ...')` y
 * `requireLectura(...)`, y esas dos líneas salían marcadas como decisiones. Vaciar toda cadena
 * cubre las tres formas y las que vengan, sin una lista de nombres que mantener.
 *
 * La excepción es el acceso indexado (`usuario['gmail_access_token']`), que SÍ es una lectura y
 * es una de las dos evasiones que encontró la revisión adversarial. Se normaliza a la forma de
 * punto antes de vaciar, para que sobreviva.
 */
function sinCadenas(src: string): string {
  return src
    .replace(/\[\s*(['"`])gmail_access_token\1\s*\]/g, '.gmail_access_token')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => m[0] + m[0]);
}

/** Y los comentarios, que EXPLICAN el problema nombrando la columna. */
function sinComentarios(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

/** ¿Este texto menciona la fuente ACTUAL? */
function leeLaOtraFuente(src: string): boolean {
  return src.includes('gmail_cuentas') || src.includes('indexarGmail');
}

/**
 * Toda aparición del identificador cuenta como LECTURA, salvo la escritura literal
 * `gmail_access_token: null` (limpiar el token al desactivar una cuenta, que es correcto).
 *
 * **La primera versión exigía un acceso a propiedad y la revisión adversarial la evadió con la
 * forma más idiomática que hay:** `const { gmail_access_token: tokenLegacy } = usuario;` seguido
 * de `if (tokenLegacy)`. Suite entera en verde con el bug original de vuelta; el acceso por
 * corchetes evadía igual. Por eso ahora la regla es al revés: se marca todo y se exceptúa la
 * única forma que no puede decidir nada.
 */
const INERTES = [
  // Escritura: limpiar el token al desactivar una cuenta.
  /gmail_access_token\s*:\s*null/g,
  // Declaración de TIPO (`gmail_access_token: string | null;` dentro de una interface). Se
  // acota a los primitivos de TS a propósito: `gmail_access_token: tokenLegacy` es un
  // destructuring con rename, que sí es una lectura, y `tokenLegacy` no es un primitivo.
  /gmail_access_token\??\s*:\s*(?:string|number|boolean|null|undefined|unknown|any)(?:\s*\|\s*(?:string|number|boolean|null|undefined|unknown|any))*\s*;?/g,
];

function esLectura(linea: string): boolean {
  if (!linea.includes('gmail_access_token')) return false;
  // Una línea puede llevar varias cosas; solo se descarta si TODA aparición es inerte.
  const resto = INERTES.reduce((acc, re) => acc.replace(re, ''), linea);
  return resto.includes('gmail_access_token');
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

/**
 * Las líneas donde la columna legacy se lee sin la otra fuente al lado.
 *
 * **Se mira por LÍNEA, no por archivo, porque la versión por archivo se evade sola.** Una
 * revisión adversarial lo midió: con la query a `gmail_cuentas` ya agregada al archivo, volver
 * el `if` del score a la columna legacy dejaba el guard en verde — el archivo mencionaba las dos
 * fuentes y la decisión usaba una.
 *
 * Rehacer la unión a mano también cuenta como infractor: `!!cuentaGmail || !!u.gmail_access_token`
 * era correcto en `/api/pro/status`, pero era la TERCERA reimplementación de la misma pregunta y
 * las otras dos estaban mal. Hoy ese archivo pasa por `indexarGmail`.
 */
function decisionesSoloLegacy(src: string): string[] {
  const lineas = sinCadenas(sinComentarios(src)).split('\n');
  // Ventana de ±1 línea, no la línea sola: una llamada a `indexarGmail` con varios argumentos
  // parte la expresión, y la mención de la columna cae en la línea de al lado.
  const vecindad = (i: number) => lineas.slice(Math.max(0, i - VENTANA), i + VENTANA + 1).join('\n');
  return lineas
    .map((l, i) => ({ l, ctx: vecindad(i) }))
    .filter(({ l }) => esLectura(l))
    .filter(({ ctx }) => !leeLaOtraFuente(ctx))
    .map(({ l }) => l.trim());
}

const archivos = archivosTs(SRC).filter((p) => !esTest(p));
const infractores = archivos
  .filter((p) => !EXENTOS.has(rel(p)))
  .filter((p) => decisionesSoloLegacy(readFileSync(p, 'utf8')).length > 0);

describe('la columna legacy de Gmail no decide nada fuera de su módulo', () => {
  it('el barrido alcanza el árbol y lo lee (antivacuidad)', () => {
    expect(archivos.length).toBeGreaterThan(100);
    expect(archivos.map(rel)).toContain('/src/app/api/admin/users/route.ts');
    expect(archivos.map(rel)).toContain('/src/app/api/score/route.ts');
    expect(archivos.map(rel)).toContain('/src/lib/gmail-conectado.ts');
  });

  it('las exenciones declaradas siguen existiendo y siguen nombrando la columna', () => {
    // Una exención que sobrevive a su motivo es un hueco. Si el archivo desapareció o dejó de
    // mencionar la columna, la entrada sobra y hay que borrarla.
    for (const ruta of EXENTOS.keys()) {
      const p = archivos.find((a) => rel(a) === ruta);
      expect(p, `exención muerta: ${ruta}`).toBeDefined();
      expect(readFileSync(p as string, 'utf8')).toContain('gmail_access_token');
    }
  });

  it('el detector distingue leer de escribir y de proyectar (antivacuidad)', () => {
    // Lee con una sola fuente: es el bug.
    expect(decisionesSoloLegacy('if (u.gmail_access_token) score += 25;')).toHaveLength(1);
    expect(decisionesSoloLegacy('const x = !!usuario?.gmail_access_token;')).toHaveLength(1);
    // Las DOS evasiones que la revisión adversarial aplicó al árbol dejando la suite en verde
    // con el bug de vuelta. El destructuring es además la forma más idiomática, o sea la que
    // alguien escribiría sin ninguna intención de evadir nada.
    expect(decisionesSoloLegacy('const { gmail_access_token: tokenLegacy } = usuario;'))
      .toHaveLength(1);
    expect(decisionesSoloLegacy("if (usuario['gmail_access_token']) visibility += 25;"))
      .toHaveLength(1);
    // Escribe (limpiar el token al desactivar): legítimo.
    expect(decisionesSoloLegacy('update({ gmail_access_token: null })')).toHaveLength(0);
    // Declara un tipo: tampoco decide nada. Y la excepción se acota a los primitivos de TS,
    // porque `gmail_access_token: tokenLegacy` tiene la misma FORMA y sí es una lectura.
    expect(decisionesSoloLegacy('  gmail_access_token: string | null;')).toHaveLength(0);
    expect(decisionesSoloLegacy('  gmail_access_token?: string;')).toHaveLength(0);
    // Proyecta: hay que pedir la columna para poder unirla.
    expect(decisionesSoloLegacy(".select('id, gmail_access_token, plan')")).toHaveLength(0);
    // Rehacer la unión a mano TAMBIÉN es infractor: era la tercera copia de la misma pregunta.
    expect(decisionesSoloLegacy('const ok = !!cuentaGmail || !!u.gmail_access_token;'))
      .toHaveLength(1);
    expect(decisionesSoloLegacy('const g = indexarGmail([u], c); if (u.gmail_access_token) {}'))
      .toHaveLength(0);
  });

  it('el vaciado de cadenas no deja ciego al barrido (antivacuidad)', () => {
    // Sin esto, un `sinCadenas` demasiado goloso dejaría el barrido sin nada que ver y el test
    // de más abajo pasaría siempre. Se comprueba sobre fixtures, no sobre el árbol.
    expect(sinCadenas("db.from('usuarios').select('id, gmail_access_token, plan')"))
      .not.toContain('gmail_access_token');
    // Las otras dos formas de proyectar que tiene esta webapp, y que la primera versión del
    // filtro —que solo entendía `.select(`— marcaba como si fueran decisiones.
    expect(sinCadenas("requireNetoUser('id, plan, gmail_access_token, tipo_plan')"))
      .not.toContain('gmail_access_token');
    expect(sinCadenas("requireLectura('id, plan, gmail_access_token')"))
      .not.toContain('gmail_access_token');
    // Lo que NO puede borrar: la lectura de la propiedad, y el acceso indexado.
    expect(sinCadenas('const tiene = !!u.gmail_access_token;')).toContain('gmail_access_token');
    expect(sinCadenas("if (u['gmail_access_token']) v += 25;")).toContain('gmail_access_token');
  });

  it('nadie lee la columna legacy para decidir', () => {
    expect(infractores.map(rel)).toEqual([]);
  });

  /**
   * Y que las rutas que arman la unión de verdad la CONSULTEN. Sin esto, `indexarGmail(usuarios,
   * [])` cumple todo lo de arriba —no menciona la columna fuera del select— y reintroduce el bug
   * entero: la mitad nueva del dato nunca se lee. Un guard de líneas no puede ver una query que
   * falta.
   */
  it('la ruta de usuarios lee las DOS fuentes', () => {
    const src = sinComentarios(
      readFileSync(join(SRC, 'app', 'api', 'admin', 'users', 'route.ts'), 'utf8'),
    );
    expect(src).toContain("from('gmail_cuentas')");
    expect(src).toMatch(/indexarGmail\(\s*filas\s*,\s*gmailCuentas/);
  });

  it('las dos rutas del score leen gmail_cuentas', () => {
    const rutas = [
      ['score', 'route.ts'],
      ['score', 'backfill', 'route.ts'],
    ];
    for (const ruta of rutas) {
      const src = sinComentarios(readFileSync(join(SRC, 'app', 'api', ...ruta), 'utf8'));
      expect(src, ruta.join('/')).toContain("from('gmail_cuentas')");
      expect(src, ruta.join('/')).toContain('indexarGmail(');
    }
  });
});
